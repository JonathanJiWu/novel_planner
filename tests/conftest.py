from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app as app_module  # noqa: E402
import auth  # noqa: E402
import auth_store  # noqa: E402
import config  # noqa: E402
import store  # noqa: E402


@pytest.fixture
def configure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Callable[..., config.Settings]:
    """Point every module at one isolated Settings object and a temporary database."""

    def apply(**overrides: Any) -> config.Settings:
        values: dict[str, Any] = {
            "supabase_url": "",
            "supabase_anon_key": "",
            "supabase_service_role_key": "",
            "jwt_issuer": "",
            "public_app_url": "",
            "oauth_providers": ("google", "github", "apple", "facebook"),
            "admin_emails": (),
            "allowed_origins": (),
            "auth_required": True,
            "auth_secret": "",
            "database_path": str(tmp_path / "accounts.db"),
        }
        values.update(overrides)
        settings = config.Settings(**values)
        for module in (config, auth, store, app_module):
            monkeypatch.setattr(module, "settings", settings)
        auth_store.reset_auth_store()
        for limiter in (
            app_module.login_failures_per_account,
            app_module.login_failures_per_client,
            app_module.registrations_per_client,
            app_module.exports_per_client,
        ):
            limiter.clear()
        return settings

    yield apply
    auth_store.reset_auth_store()


@pytest.fixture
def client(configure: Callable[..., config.Settings]):
    """A TestClient for the production app in built-in account mode."""
    from fastapi.testclient import TestClient

    configure(admin_emails=("owner@example.com",))
    with TestClient(app_module.app) as test_client:
        yield test_client


def register(client: Any, email: str = "writer@example.com", password: str = "correct-horse-battery") -> dict[str, str]:
    response = client.post("/api/auth/register", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}
