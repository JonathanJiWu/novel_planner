"""Production FastAPI application: accounts, per-user projects, exports, and admin."""
from __future__ import annotations

import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from auth import AuthenticatedUser, bearer_token, require_admin, require_user
from auth_store import ReservedEmailError, get_auth_store
from config import settings
from exports import build_markdown, build_pdf
from novel_architect import build_planning_stages, question_catalog
from project_data import MAX_REQUEST_BYTES, ConflictError, parse_revision, validate_project_data
from rate_limit import SlidingWindowLimiter
from store import ProjectStore


logger = logging.getLogger("novel_architect")
if not logger.handlers:
    # Uvicorn configures only its own loggers; make ours (migrations, backups,
    # storage errors) visible in the service log as well.
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s - %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
OWNER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
STORAGE_UNAVAILABLE = "The project storage is temporarily unavailable. Please try again shortly."

store = ProjectStore()
# Failed logins per (client, account) and per client, and registrations per client.
login_failures_per_account = SlidingWindowLimiter(10, 15 * 60)
login_failures_per_client = SlidingWindowLimiter(100, 15 * 60)
registrations_per_client = SlidingWindowLimiter(20, 60 * 60)
# Exports of a project sent in the request (visitors who have not signed in).
exports_per_client = SlidingWindowLimiter(30, 60)


class AuthRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=200)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    if settings.configured:
        logger.info("Accounts and projects are stored in Supabase at %s.", settings.supabase_url)
    else:
        # Open the database now so migrations run (and fail loudly) at startup.
        database = await run_in_threadpool(get_auth_store)
        logger.info("Accounts and projects are stored in SQLite at %s.", database.path)
        if not settings.auth_required:
            logger.warning(
                "AUTH_REQUIRED is false: requests without a session share one project. "
                "Set AUTH_REQUIRED=true for any deployment that other people can reach."
            )
    yield


app = FastAPI(title="Novel Architect", version="1.1", lifespan=lifespan)


def content_security_policy() -> str:
    script_sources = ["'self'"]
    connect_sources = ["'self'"]
    if settings.configured:
        script_sources.append("https://cdn.jsdelivr.net")
        connect_sources.append(settings.supabase_url)
    return "; ".join(
        [
            "default-src 'self'",
            f"script-src {' '.join(script_sources)}",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            f"connect-src {' '.join(connect_sources)}",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


@app.middleware("http")
async def security_headers(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Content-Security-Policy", content_security_policy())
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    else:
        # Revalidate static assets so a deployment is picked up immediately.
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )


def _client_id(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _storage_error(exc: Exception) -> HTTPException:
    logger.error("Project storage failed: %s", exc, exc_info=exc)
    return HTTPException(status_code=503, detail=STORAGE_UNAVAILABLE)


def _too_many_requests(retry_after: float) -> HTTPException:
    seconds = max(1, int(retry_after + 0.999))
    minutes = max(1, round(seconds / 60))
    return HTTPException(
        status_code=429,
        detail=f"Too many attempts. Try again in about {minutes} minute{'s' if minutes != 1 else ''}.",
        headers={"Retry-After": str(seconds)},
    )


def _require_builtin_accounts() -> None:
    if settings.configured:
        raise HTTPException(status_code=404, detail="Accounts are managed by Supabase on this deployment.")


async def _read_json_body(request: Request) -> Any:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="The project is larger than 2 MB and was not saved.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="The project is larger than 2 MB and was not saved.")
    if not body:
        raise HTTPException(status_code=400, detail="The request body is empty.")
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="The request body is not valid JSON.") from exc


@app.get("/api/health")
async def health() -> JSONResponse:
    body: dict[str, Any] = {
        "status": "ok",
        "auth_mode": settings.auth_mode,
        "supabase_configured": settings.configured,
    }
    commit = os.getenv("RENDER_GIT_COMMIT") or os.getenv("GIT_COMMIT")
    if commit:
        body["commit"] = commit
    try:
        await store.health_check()
    except Exception as exc:  # noqa: BLE001 - report any storage failure as unhealthy
        logger.error("Health check failed: %s", exc, exc_info=exc)
        body["status"] = "unavailable"
        return JSONResponse(body, status_code=503)
    return JSONResponse(body)


@app.get("/api/config")
async def public_config() -> dict[str, str | bool]:
    return {
        "supabase_configured": settings.configured,
        "supabase_url": settings.supabase_url if settings.configured else "",
        "supabase_anon_key": settings.supabase_anon_key if settings.configured else "",
        "auth_required": settings.auth_required,
        "public_app_url": settings.public_app_url,
        "oauth_providers": ",".join(settings.oauth_providers),
        "auth_mode": settings.auth_mode,
    }


@app.post("/api/auth/register")
def register(payload: AuthRequest, request: Request) -> dict[str, Any]:
    _require_builtin_accounts()
    client = _client_id(request)
    retry_after = registrations_per_client.retry_after(client)
    if retry_after:
        raise _too_many_requests(retry_after)
    # Count every attempt, so the endpoint cannot be used to probe addresses quickly.
    registrations_per_client.hit(client)
    try:
        token, user = get_auth_store().register(payload.email, payload.password)
    except ReservedEmailError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409 if "exists" in str(exc) else 400, detail=str(exc)) from exc
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.post("/api/auth/login")
def login(payload: AuthRequest, request: Request) -> dict[str, Any]:
    _require_builtin_accounts()
    client = _client_id(request)
    account_key = (client, payload.email.strip().lower())
    retry_after = max(
        login_failures_per_account.retry_after(account_key),
        login_failures_per_client.retry_after(client),
    )
    if retry_after:
        raise _too_many_requests(retry_after)
    try:
        token, user = get_auth_store().login(payload.email, payload.password)
    except ValueError as exc:
        login_failures_per_account.hit(account_key)
        login_failures_per_client.hit(client)
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    login_failures_per_account.reset(account_key)
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    _require_builtin_accounts()
    token = bearer_token(authorization)
    if token:
        get_auth_store().logout(token)
    return {"signed_out": True}


@app.get("/api/me")
async def current_user(user: AuthenticatedUser = Depends(require_user)) -> dict[str, Any]:
    return {"user_id": user.user_id, "email": user.email, "is_admin": settings.is_admin_email(user.email)}


@app.get("/api/admin/projects")
async def admin_projects(_admin: AuthenticatedUser = Depends(require_admin)) -> list[dict[str, Any]]:
    try:
        return await store.list_projects()
    except RuntimeError as exc:
        raise _storage_error(exc) from exc


@app.delete("/api/admin/projects/{owner_id}")
async def admin_delete_project(
    owner_id: str,
    _admin: AuthenticatedUser = Depends(require_admin),
) -> dict[str, bool]:
    if not OWNER_ID_PATTERN.match(owner_id):
        raise HTTPException(status_code=400, detail="Invalid project owner id.")
    try:
        deleted = await store.delete_project(owner_id)
    except RuntimeError as exc:
        raise _storage_error(exc) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="No project exists for that owner.")
    logger.warning("Administrator %s deleted the project owned by %s.", _admin.email, owner_id)
    return {"deleted": True}


async def _load_project(user: AuthenticatedUser) -> dict[str, Any]:
    try:
        data = await store.load(user.user_id, user.access_token)
    except RuntimeError as exc:
        raise _storage_error(exc) from exc
    try:
        return validate_project_data(data)
    except ValueError as exc:
        logger.error("Stored project for %s failed validation: %s", user.user_id, exc)
        raise HTTPException(status_code=500, detail="The saved project could not be read.") from exc


@app.get("/api/project")
async def get_project(user: AuthenticatedUser = Depends(require_user)) -> dict[str, Any]:
    return await _load_project(user)


@app.put("/api/project")
async def put_project(request: Request, user: AuthenticatedUser = Depends(require_user)) -> Any:
    payload = await _read_json_body(request)
    try:
        base_revision = parse_revision(payload.get("revision")) if isinstance(payload, dict) else None
        clean_data = validate_project_data(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return await store.save(user.user_id, clean_data, user.access_token, base_revision)
    except ConflictError as exc:
        return JSONResponse({"detail": str(exc), "project": exc.current}, status_code=409)
    except RuntimeError as exc:
        raise _storage_error(exc) from exc


@app.get("/api/questions")
async def questions() -> list[dict[str, Any]]:
    return question_catalog()


@app.get("/api/stages")
async def stages() -> list[dict[str, str]]:
    return build_planning_stages()


async def _export(pdf: bool, user: AuthenticatedUser) -> Response:
    return await _render_export(await _load_project(user), pdf, user.user_id)


async def _render_export(data: dict[str, Any], pdf: bool, owner: str) -> Response:
    try:
        if pdf:
            content = await run_in_threadpool(build_pdf, data)
        else:
            content = build_markdown(data).encode("utf-8")
    except Exception as exc:  # noqa: BLE001 - never leak renderer internals to the client
        logger.error("Export failed for %s: %s", owner, exc, exc_info=exc)
        raise HTTPException(status_code=500, detail="The export could not be generated.") from exc
    extension, media_type = ("pdf", "application/pdf") if pdf else ("md", "text/markdown; charset=utf-8")
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="novel-writing-plan.{extension}"'},
    )


@app.get("/api/export")
async def export_markdown(user: AuthenticatedUser = Depends(require_user)) -> Response:
    return await _export(False, user)


@app.get("/api/export/pdf")
async def export_pdf(user: AuthenticatedUser = Depends(require_user)) -> Response:
    return await _export(True, user)


async def _export_sent_project(request: Request, pdf: bool) -> Response:
    """Render a project sent in the request body; nothing is stored."""
    client = _client_id(request)
    retry_after = exports_per_client.retry_after(client)
    if retry_after:
        raise _too_many_requests(retry_after)
    exports_per_client.hit(client)
    payload = await _read_json_body(request)
    try:
        data = validate_project_data(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await _render_export(data, pdf, "a visitor")


@app.post("/api/export")
async def export_sent_markdown(request: Request) -> Response:
    return await _export_sent_project(request, False)


@app.post("/api/export/pdf")
async def export_sent_pdf(request: Request) -> Response:
    return await _export_sent_project(request, True)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
async def api_not_found(path: str) -> JSONResponse:
    return JSONResponse({"detail": "Not found."}, status_code=404)


app.mount("/", StaticFiles(directory=WEB_ROOT, html=True), name="web")
