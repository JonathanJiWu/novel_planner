"""Single-user local server for Novel Architect.

Runs with the Python standard library (reportlab is only needed for PDF export)
and keeps the project in a JSON file next to this script. It has no accounts:
bind it to localhost only. Use ``app.py`` for anything shared.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from exports import build_markdown, build_pdf
from novel_architect import build_planning_stages, question_catalog
from project_data import (
    IDEA_CATEGORIES,
    MATERIAL_STATUSES,
    MAX_REQUEST_BYTES,
    THEMES,
    ConflictError,
    new_project_data,
    parse_revision,
    storable,
    validate_project_data,
)


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
PROJECT_FILE = Path(os.getenv("NOVEL_PLANNER_PROJECT_FILE", ROOT / "novel_project.json"))
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
}
_save_lock = threading.Lock()

__all__ = [
    "IDEA_CATEGORIES",
    "MATERIAL_STATUSES",
    "MAX_REQUEST_BYTES",
    "THEMES",
    "build_markdown",
    "build_pdf",
    "load_project_data",
    "new_project_data",
    "save_project_data",
    "validate_project_data",
]


def load_project_data(path: Path = PROJECT_FILE) -> dict[str, Any]:
    if not path.exists():
        return new_project_data()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read saved novel project at {path}: {exc}") from exc
    return validate_project_data(data)


def save_project_data(
    data: dict[str, Any],
    path: Path = PROJECT_FILE,
    base_revision: int | None = None,
) -> dict[str, Any]:
    """Validate and atomically write the project.

    When ``base_revision`` is given and differs from the stored revision, the
    save is rejected with :class:`ConflictError` so a stale browser tab cannot
    overwrite newer work.
    """
    clean_data = validate_project_data(data)
    with _save_lock:
        current = load_project_data(path)
        current_revision = current["revision"] if path.exists() else 0
        if base_revision is not None and base_revision != current_revision:
            raise ConflictError(current)
        clean_data = storable(clean_data)
        clean_data["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        clean_data["revision"] = current_revision + 1
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                json.dump(clean_data, temporary_file, ensure_ascii=False, indent=2)
            temporary_path.replace(path)
        except OSError as exc:
            raise RuntimeError(f"Could not save novel project at {path}: {exc}") from exc
        finally:
            if temporary_path is not None and temporary_path.exists():
                os.unlink(temporary_path)
    return clean_data


class NovelPlannerHandler(BaseHTTPRequestHandler):
    server_version = "NovelArchitect/1.1"
    project_file: Path = PROJECT_FILE

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/health":
            self._send_json({"status": "ok", "auth_mode": "local"})
        elif path == "/api/config":
            self._send_json(
                {
                    "auth_mode": "local",
                    "auth_required": False,
                    "supabase_configured": False,
                    "supabase_url": "",
                    "supabase_anon_key": "",
                }
            )
        elif path == "/api/project":
            try:
                self._send_json(load_project_data(self.project_file))
            except (RuntimeError, ValueError) as exc:
                self._send_error_json(500, "The saved project could not be read.", exc)
        elif path == "/api/questions":
            self._send_json(question_catalog())
        elif path == "/api/stages":
            self._send_json(build_planning_stages())
        elif path in {"/api/export", "/api/export/pdf"}:
            pdf = path.endswith("/pdf")
            try:
                data = load_project_data(self.project_file)
                content = build_pdf(data) if pdf else build_markdown(data).encode("utf-8")
            except (RuntimeError, ValueError) as exc:
                self._send_error_json(500, "The export could not be generated.", exc)
                return
            self._send_bytes(
                content,
                "application/pdf" if pdf else "text/markdown; charset=utf-8",
                {
                    "Content-Disposition": (
                        f'attachment; filename="novel-writing-plan.{"pdf" if pdf else "md"}"'
                    ),
                    "Cache-Control": "no-store",
                },
            )
        elif path.startswith("/api/"):
            self._send_json({"detail": "Not found."}, status=404)
        else:
            self._send_static(path)

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/project":
            self._send_json({"detail": "Not found."}, status=404)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json({"detail": "Invalid Content-Length header."}, status=400)
            return
        if content_length <= 0:
            self._send_json({"detail": "The request body is empty."}, status=400)
            return
        if content_length > MAX_REQUEST_BYTES:
            self._send_json({"detail": "The project is larger than 2 MB and was not saved."}, status=413)
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            base_revision = parse_revision(payload.get("revision")) if isinstance(payload, dict) else None
            saved_data = save_project_data(payload, self.project_file, base_revision)
        except ConflictError as exc:
            self._send_json({"detail": str(exc), "project": exc.current}, status=409)
            return
        except (ValueError, UnicodeDecodeError) as exc:
            self._send_json({"detail": str(exc)}, status=400)
            return
        except RuntimeError as exc:
            self._send_error_json(500, "The project could not be saved.", exc)
            return
        self._send_json(saved_data)

    def do_POST(self) -> None:
        self._send_json({"detail": "Accounts are not available in the local single-user server."}, status=404)

    def _send_static(self, path: str) -> None:
        name = unquote(path).lstrip("/") or "index.html"
        file_path = (WEB_ROOT / name).resolve()
        content_type = STATIC_TYPES.get(file_path.suffix.lower())
        if file_path.parent != WEB_ROOT or content_type is None or not file_path.is_file():
            self._send_json({"detail": "Not found."}, status=404)
            return
        self._send_bytes(file_path.read_bytes(), content_type, {"Cache-Control": "no-cache"})

    def _send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", {"Cache-Control": "no-store"}, status)

    def _send_error_json(self, status: int, message: str, exc: Exception) -> None:
        self.log_message("%s: %s", message, exc)
        self._send_json({"detail": message}, status=status)

    def _send_bytes(
        self,
        body: bytes,
        content_type: str,
        headers: dict[str, str] | None = None,
        status: int = 200,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in {**SECURITY_HEADERS, **(headers or {})}.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format_string % args}")


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Novel Architect single-user local server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--project-file", type=Path, default=PROJECT_FILE, help="Where to keep the project JSON")
    args = parser.parse_args()

    NovelPlannerHandler.project_file = args.project_file
    server = ThreadingHTTPServer((args.host, args.port), NovelPlannerHandler)
    print(f"Novel Architect is running at http://{args.host}:{args.port}")
    print(f"Project data is saved in {args.project_file}. Press Ctrl+C to stop.")
    if not _is_loopback(args.host):
        print("WARNING: this server has no accounts. Anyone who can reach it can read and change the project.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Novel Architect.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
