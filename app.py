from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from auth import AuthenticatedUser, require_admin, require_user
from config import settings
from novel_architect import NovelProject, build_planning_stages
from store import ProjectStore
from web_app import MAX_REQUEST_BYTES, build_markdown, build_pdf, validate_project_data


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
store = ProjectStore()
app = FastAPI(title="Novel Architect", version="1.0")

if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )


@app.get("/api/health")
async def health() -> dict[str, str | bool]:
    return {"status": "ok", "supabase_configured": settings.configured}


@app.get("/api/config")
async def public_config() -> dict[str, str | bool]:
    return {
        "supabase_configured": settings.configured,
        "supabase_url": settings.supabase_url if settings.configured else "",
        "supabase_anon_key": settings.supabase_anon_key if settings.configured else "",
        "auth_required": settings.auth_required,
    }


@app.get("/api/me")
async def current_user(user: AuthenticatedUser = Depends(require_user)) -> dict[str, Any]:
    return {
        "user_id": user.user_id,
        "email": user.email,
        "is_admin": bool(
            user.email
            and settings.admin_emails
            and user.email.lower() in settings.admin_emails
        ),
    }


@app.get("/api/admin/projects")
async def admin_projects(_admin: AuthenticatedUser = Depends(require_admin)) -> list[dict[str, Any]]:
    try:
        return await store.list_projects()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/admin/projects/{owner_id}")
async def admin_delete_project(
    owner_id: str,
    _admin: AuthenticatedUser = Depends(require_admin),
) -> dict[str, bool]:
    try:
        await store.delete_project(owner_id)
        return {"deleted": True}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/project")
async def get_project(user: AuthenticatedUser = Depends(require_user)) -> dict[str, Any]:
    try:
        return validate_project_data(await store.load(user.user_id, user.access_token))
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/project")
async def put_project(
    request: Request,
    user: AuthenticatedUser = Depends(require_user),
) -> dict[str, Any]:
    content_length = int(request.headers.get("content-length", "0"))
    if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="Request body must be between 1 byte and 2 MB.")
    try:
        payload = await request.json()
        clean_data = validate_project_data(payload)
        return await store.save(user.user_id, clean_data, user.access_token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/questions")
async def questions() -> list[dict[str, Any]]:
    project = NovelProject.with_questions("Novel")
    return [
        {
            **question.__dict__,
            "answer": "",
            "dependencies": list(question.dependencies),
        }
        for question in project.questions.values()
    ]


@app.get("/api/stages")
async def stages() -> list[dict[str, str]]:
    return build_planning_stages()


async def _export(
    pdf: bool,
    user: AuthenticatedUser,
) -> Response:
    try:
        data = validate_project_data(await store.load(user.user_id, user.access_token))
        if pdf:
            content = build_pdf(data)
            return Response(
                content=content,
                media_type="application/pdf",
                headers={"Content-Disposition": 'attachment; filename="novel-writing-plan.pdf"'},
            )
        return Response(
            content=build_markdown(data).encode("utf-8"),
            media_type="text/markdown",
            headers={"Content-Disposition": 'attachment; filename="novel-writing-plan.md"'},
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/export")
async def export_markdown(user: AuthenticatedUser = Depends(require_user)) -> Response:
    return await _export(False, user)


@app.get("/api/export/pdf")
async def export_pdf(user: AuthenticatedUser = Depends(require_user)) -> Response:
    return await _export(True, user)


app.mount("/", StaticFiles(directory=WEB_ROOT, html=True), name="web")
