"""The single-user local server (web_app.py), exercised over real HTTP."""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import web_app


@pytest.fixture
def local_server(tmp_path, monkeypatch):
    project_file = tmp_path / "novel_project.json"
    monkeypatch.setattr(web_app.NovelPlannerHandler, "project_file", project_file)
    monkeypatch.setattr(web_app.NovelPlannerHandler, "log_message", lambda *args: None)
    server = ThreadingHTTPServer(("127.0.0.1", 0), web_app.NovelPlannerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", project_file
    finally:
        server.shutdown()
        server.server_close()


def request(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def test_local_config_reports_no_accounts(local_server):
    base, _ = local_server
    status, _headers, body = request(f"{base}/api/config")
    assert status == 200
    assert json.loads(body)["auth_mode"] == "local"


def test_project_saves_with_revisions_and_rejects_stale_writes(local_server):
    base, project_file = local_server
    status, _h, body = request(f"{base}/api/project?cache=bust")  # query strings are tolerated
    assert status == 200
    assert json.loads(body)["revision"] == 0

    status, _h, body = request(f"{base}/api/project", "PUT", {"title": "Local Novel", "revision": 0})
    assert status == 200
    assert json.loads(body)["revision"] == 1
    assert json.loads(project_file.read_text())["title"] == "Local Novel"

    status, _h, body = request(f"{base}/api/project", "PUT", {"title": "Stale", "revision": 0})
    assert status == 409
    assert json.loads(body)["project"]["title"] == "Local Novel"

    status, _h, body = request(f"{base}/api/project", "PUT", {"title": "", "revision": 1})
    assert status == 200
    assert json.loads(body)["title"] == "Untitled novel"


def test_invalid_projects_are_rejected_without_touching_the_file(local_server):
    base, project_file = local_server
    request(f"{base}/api/project", "PUT", {"title": "Keep me", "revision": 0})
    status, _h, body = request(f"{base}/api/project", "PUT", {"title": "x", "ideas": [{"id": "i", "text": ""}], "revision": 1})
    assert status == 400
    assert "idea" in json.loads(body)["detail"]
    assert json.loads(project_file.read_text())["title"] == "Keep me"


def test_static_files_and_security_headers(local_server):
    base, _ = local_server
    for path, content_type in [
        ("/", "text/html"),
        ("/index.html", "text/html"),
        ("/app.js", "text/javascript"),
        ("/planner-logic.js", "text/javascript"),
        ("/styles.css", "text/css"),
        ("/favicon.svg", "image/svg+xml"),
    ]:
        status, headers, _body = request(f"{base}{path}")
        assert status == 200, path
        assert headers["Content-Type"].startswith(content_type)
        assert headers["X-Content-Type-Options"] == "nosniff"
    for path in ["/../web_app.py", "/%2e%2e/web_app.py", "/missing.js", "/api/nothing"]:
        status, _headers, _body = request(f"{base}{path}")
        assert status == 404, path


def test_exports(local_server):
    base, _ = local_server
    request(f"{base}/api/project", "PUT", {"title": "Export Novel", "answers": {"story_identity": "A premise."}, "revision": 0})
    status, headers, body = request(f"{base}/api/export")
    assert status == 200
    assert headers["Content-Type"].startswith("text/markdown")
    assert "A premise." in body.decode()
    status, headers, body = request(f"{base}/api/export/pdf")
    assert status == 200
    assert body.startswith(b"%PDF")
