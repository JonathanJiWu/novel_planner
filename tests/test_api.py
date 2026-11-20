"""Production API journeys (built-in accounts, SQLite) through FastAPI's TestClient."""
from __future__ import annotations

import json

import pytest

import app as app_module
from auth_store import get_auth_store
from tests.conftest import register


def project_payload(**changes):
    payload = {
        "title": "The Quiet Archive",
        "answers": {"story_identity": "A librarian finds a forbidden record."},
        "question_states": {"story_identity": {"planning_level": "essential", "certainty": "provisional"}},
        "ideas": [{"id": "idea-1", "text": "The librarian fears being forgotten.", "category": "Character"}],
        "materials": [],
        "theme": "paper",
        "revision": 0,
    }
    payload.update(changes)
    return payload


def test_health_and_public_config(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok", "auth_mode": "builtin", "supabase_configured": False}

    config = client.get("/api/config").json()
    assert config["auth_mode"] == "builtin"
    assert config["auth_required"] is True
    assert config["supabase_anon_key"] == ""


def test_health_reports_storage_failure(client, monkeypatch):
    def broken():
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(get_auth_store(), "health_check", broken)
    response = client.get("/api/health")
    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"


def test_registration_and_login_journey(client):
    headers = register(client, "Writer@Example.com")
    me = client.get("/api/me", headers=headers).json()
    assert me["email"] == "writer@example.com"
    assert me["is_admin"] is False

    duplicate = client.post("/api/auth/register", json={"email": "writer@example.com", "password": "another-password"})
    assert duplicate.status_code == 409

    login = client.post("/api/auth/login", json={"email": "WRITER@example.com", "password": "correct-horse-battery"})
    assert login.status_code == 200
    assert login.json()["user"]["email"] == "writer@example.com"

    wrong = client.post("/api/auth/login", json={"email": "writer@example.com", "password": "wrong-password"})
    assert wrong.status_code == 401
    assert wrong.json()["detail"] == "Invalid email or password."


@pytest.mark.parametrize(
    ("email", "password", "status"),
    [("not-an-email", "long-enough-password", 400), ("a@example.com", "short", 422)],
)
def test_registration_rejects_invalid_credentials(client, email, password, status):
    response = client.post("/api/auth/register", json={"email": email, "password": password})
    assert response.status_code == status


def test_administrator_addresses_cannot_be_claimed_through_public_registration(client):
    # Regression: anyone could register an ADMIN_EMAILS address and become an administrator.
    response = client.post("/api/auth/register", json={"email": "Owner@Example.com", "password": "attacker-password"})
    assert response.status_code == 403
    assert "manage.py create-user" in response.json()["detail"]


def test_failed_logins_are_rate_limited(client):
    register(client)
    for _ in range(10):
        response = client.post("/api/auth/login", json={"email": "writer@example.com", "password": "wrong-password"})
        assert response.status_code == 401
    blocked = client.post("/api/auth/login", json={"email": "writer@example.com", "password": "correct-horse-battery"})
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0


def test_logout_revokes_the_session(client):
    headers = register(client)
    assert client.get("/api/project", headers=headers).status_code == 200
    assert client.post("/api/auth/logout", headers=headers).json() == {"signed_out": True}
    expired = client.get("/api/project", headers=headers)
    assert expired.status_code == 401
    assert "log in again" in expired.json()["detail"]


def test_requests_without_a_valid_session_are_rejected(client):
    assert client.get("/api/project").status_code == 401
    assert client.get("/api/project", headers={"Authorization": "Bearer not-a-token"}).status_code == 401
    assert client.get("/api/export").status_code == 401
    assert client.put("/api/project", json=project_payload()).status_code == 401


def test_new_account_starts_with_an_empty_project(client, tmp_path, monkeypatch):
    # Regression: new accounts were shown the server's local novel_project.json.
    import web_app

    leaked = tmp_path / "novel_project.json"
    leaked.write_text(json.dumps({"title": "Someone else's novel", "ideas": [{"id": "x", "text": "private", "category": "Story"}]}))
    monkeypatch.setattr(web_app, "PROJECT_FILE", leaked)

    project = client.get("/api/project", headers=register(client)).json()
    assert project["title"] == "My Novel"
    assert project["ideas"] == []
    assert project["revision"] == 0


def test_project_round_trip_and_revisions(client):
    headers = register(client)
    first = client.put("/api/project", json=project_payload(), headers=headers)
    assert first.status_code == 200
    assert first.json()["revision"] == 1
    assert first.json()["saved_at"]

    second = client.put("/api/project", json=project_payload(title="Renamed", revision=1), headers=headers)
    assert second.json()["revision"] == 2

    loaded = client.get("/api/project", headers=headers).json()
    assert loaded["title"] == "Renamed"
    assert loaded["revision"] == 2
    assert loaded["theme"] == "paper"
    assert loaded["question_states"]["story_identity"]["certainty"] == "provisional"


def test_stale_save_is_rejected_with_the_current_project(client):
    headers = register(client)
    client.put("/api/project", json=project_payload(), headers=headers)
    client.put("/api/project", json=project_payload(title="Saved in another tab", revision=1), headers=headers)

    stale = client.put("/api/project", json=project_payload(title="Stale tab", revision=1), headers=headers)
    assert stale.status_code == 409
    body = stale.json()
    assert body["project"]["title"] == "Saved in another tab"
    assert body["project"]["revision"] == 2
    assert client.get("/api/project", headers=headers).json()["title"] == "Saved in another tab"


def test_clients_without_revision_tracking_can_still_save(client):
    headers = register(client)
    payload = project_payload()
    del payload["revision"]
    assert client.put("/api/project", json=payload, headers=headers).status_code == 200
    assert client.put("/api/project", json=payload, headers=headers).json()["revision"] == 2


def test_blank_title_does_not_block_saving(client):
    # Regression: clearing the title made every save fail, silently losing all later edits.
    headers = register(client)
    response = client.put("/api/project", json=project_payload(title="   "), headers=headers)
    assert response.status_code == 200
    assert response.json()["title"] == "Untitled novel"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"answers": {"not_a_question": "x"}}, "Invalid answer entry"),
        ({"ideas": [{"id": "i", "text": "   ", "category": "Story"}]}, "Each idea must contain"),
        ({"materials": [{"id": "m", "text": "", "category": "Story", "status": "imported", "source": "a.txt"}]}, "Each material"),
        ({"theme": "neon"}, "Unknown theme"),
        ({"revision": -1}, "Revision"),
    ],
)
def test_invalid_projects_are_rejected_with_a_reason(client, change, message):
    response = client.put("/api/project", json=project_payload(**change), headers=register(client))
    assert response.status_code == 400
    assert message in response.json()["detail"]


def test_malformed_and_oversized_bodies_are_rejected(client):
    headers = register(client)
    invalid = client.put("/api/project", content=b"{not json", headers={**headers, "Content-Type": "application/json"})
    assert invalid.status_code == 400
    empty = client.put("/api/project", content=b"", headers=headers)
    assert empty.status_code == 400
    huge = json.dumps(project_payload(answers={"story_identity": "x" * 2_100_000}))
    too_large = client.put("/api/project", content=huge, headers={**headers, "Content-Type": "application/json"})
    assert too_large.status_code == 413


def test_projects_are_isolated_between_accounts(client):
    alice = register(client, "alice@example.com")
    bob = register(client, "bob@example.com")
    client.put("/api/project", json=project_payload(title="Alice's secret novel"), headers=alice)
    assert client.get("/api/project", headers=bob).json()["title"] == "My Novel"


def test_exports_use_the_saved_project(client):
    headers = register(client)
    client.put(
        "/api/project",
        json=project_payload(answers={"story_identity": "Line one\nLine two", "protagonist": "林黛玉"}),
        headers=headers,
    )
    markdown = client.get("/api/export", headers=headers)
    assert markdown.status_code == 200
    assert markdown.headers["content-type"].startswith("text/markdown")
    assert "attachment" in markdown.headers["content-disposition"]
    assert "  - Line one\n    Line two" in markdown.text
    assert "林黛玉" in markdown.text

    pdf = client.get("/api/export/pdf", headers=headers)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF")
    assert pdf.headers["cache-control"] == "no-store"


def test_visitors_can_export_without_signing_in(client):
    payload = project_payload(answers={"story_identity": "A guest's premise"})
    markdown = client.post("/api/export", json=payload)
    assert markdown.status_code == 200
    assert markdown.text.startswith("# The Quiet Archive\n")
    assert "A guest's premise" in markdown.text
    assert "## Ready to Write Chapter One?" in markdown.text
    pdf = client.post("/api/export/pdf", json=payload)
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")
    assert client.post("/api/export", json={"title": "x", "theme": "neon"}).status_code == 400
    assert client.get("/api/project").status_code == 401  # nothing is stored for visitors


def test_visitor_exports_are_rate_limited(client):
    for _ in range(30):
        assert client.post("/api/export", json=project_payload()).status_code == 200
    limited = client.post("/api/export", json=project_payload())
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) > 0


def test_storage_errors_do_not_leak_internal_details(client, monkeypatch):
    headers = register(client)

    async def broken(*_args, **_kwargs):
        raise RuntimeError("Supabase project read failed: secret internal response")

    monkeypatch.setattr(app_module.store, "load", broken)
    response = client.get("/api/project", headers=headers)
    assert response.status_code == 503
    assert "secret internal response" not in response.text


def test_administration_requires_an_administrator(client):
    headers = register(client)
    assert client.get("/api/admin/projects", headers=headers).status_code == 403
    assert client.delete("/api/admin/projects/someone", headers=headers).status_code == 403


def test_administrator_created_on_the_server_can_list_and_delete_projects(client):
    get_auth_store().register("owner@example.com", "operator-password", allow_reserved=True)
    admin = {"Authorization": "Bearer " + client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "operator-password"}
    ).json()["access_token"]}
    assert client.get("/api/me", headers=admin).json()["is_admin"] is True

    writer = register(client)
    client.put("/api/project", json=project_payload(), headers=writer)
    projects = client.get("/api/admin/projects", headers=admin).json()
    assert len(projects) == 1
    listed = projects[0]
    assert listed["email"] == "writer@example.com"
    assert listed["title"] == "The Quiet Archive"
    assert "data" not in listed  # the directory does not ship every user's full project

    assert client.delete("/api/admin/projects/../etc", headers=admin).status_code in {400, 404}
    assert client.delete("/api/admin/projects/bad$id", headers=admin).status_code == 400
    assert client.delete(f"/api/admin/projects/{listed['owner_id']}", headers=admin).json() == {"deleted": True}
    assert client.delete(f"/api/admin/projects/{listed['owner_id']}", headers=admin).status_code == 404
    assert client.get("/api/project", headers=writer).json()["title"] == "My Novel"


def test_security_headers(client):
    page = client.get("/")
    assert page.status_code == 200
    assert page.headers["x-content-type-options"] == "nosniff"
    assert page.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert "cdn.jsdelivr.net" not in page.headers["content-security-policy"]
    assert page.headers["cache-control"] == "no-cache"
    assert client.get("/api/questions").headers["cache-control"] == "no-store"


def test_unknown_api_routes_return_json(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"detail": "Not found."}


def test_optional_auth_uses_a_shared_local_project(configure):
    from fastapi.testclient import TestClient

    configure(auth_required=False)
    with TestClient(app_module.app) as client:
        saved = client.put("/api/project", json=project_payload())
        assert saved.status_code == 200
        assert client.get("/api/project").json()["title"] == "The Quiet Archive"


def test_supabase_deployments_disable_built_in_accounts(configure):
    from fastapi.testclient import TestClient

    configure(supabase_url="https://example.supabase.co", supabase_anon_key="anon-key")
    with TestClient(app_module.app) as client:
        response = client.post("/api/auth/register", json={"email": "a@example.com", "password": "long-enough-password"})
        assert response.status_code == 404
        assert "cdn.jsdelivr.net" in client.get("/").headers["content-security-policy"]
        assert "https://example.supabase.co" in client.get("/").headers["content-security-policy"]
