import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

import auth
from auth import AuthenticatedUser
from config import Settings


def test_auth_configuration_supports_live_redirect_and_providers():
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="publishable-key",
        public_app_url="https://jonathanjiwu.github.io/novel_planner/",
        oauth_providers=("google", "github", "apple", "facebook"),
    )

    assert settings.configured
    assert settings.public_app_url == "https://jonathanjiwu.github.io/novel_planner/"
    assert set(settings.oauth_providers) == {"google", "github", "apple", "facebook"}


def test_local_development_user_is_available_when_auth_is_optional(monkeypatch):
    monkeypatch.setattr(
        auth,
        "settings",
        Settings(supabase_url="", supabase_anon_key="", auth_required=False),
    )

    user = auth.require_user()

    assert user.user_id == "local-development-user"
    assert user.email is None


def test_admin_allowlist_accepts_and_rejects_users(monkeypatch):
    monkeypatch.setattr(
        auth,
        "settings",
        Settings(
            supabase_url="https://example.supabase.co",
            supabase_anon_key="publishable-key",
            admin_emails=("owner@example.com",),
        ),
    )

    owner = AuthenticatedUser("owner-id", "Owner@Example.com")
    assert auth.require_admin(owner).user_id == "owner-id"

    with pytest.raises(HTTPException) as exc:
        auth.require_admin(AuthenticatedUser("other-id", "other@example.com"))
    assert exc.value.status_code == 403


def test_auth_frontend_contains_password_and_all_supported_providers():
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text(encoding="utf-8")
    javascript = (root / "web" / "app.js").read_text(encoding="utf-8")

    assert 'id="auth-email"' in html
    assert 'id="auth-password"' in html
    assert 'id="sign-in"' in html
    assert 'id="sign-up"' in html
    assert 'data-provider="google"' in html
    assert 'data-provider="github"' in html
    assert 'data-provider="apple"' in html
    assert 'data-provider="facebook"' in html
    assert "signInWithPassword" in javascript
    assert "signUp" in javascript
    assert "signInWithOAuth" in javascript
    assert "detectSessionInUrl: true" in javascript
