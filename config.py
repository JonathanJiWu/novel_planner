from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _csv(name: str, default: str = "", *, lower: bool = False) -> tuple[str, ...]:
    values = (item.strip() for item in _env(name, default).split(","))
    return tuple(value.lower() if lower else value for value in values if value)


def resolve_data_path(value: str | os.PathLike[str]) -> Path:
    """Resolve a data path; relative paths are anchored at the project root.

    Anchoring at the project root (instead of the current working directory)
    keeps accounts and projects in one place no matter where the server or the
    test suite is started from.
    """
    path = Path(value).expanduser()
    return path if path.is_absolute() else PROJECT_ROOT / path


@dataclass(frozen=True)
class Settings:
    supabase_url: str = field(default_factory=lambda: _env("SUPABASE_URL").rstrip("/"))
    supabase_anon_key: str = field(default_factory=lambda: _env("SUPABASE_ANON_KEY"))
    supabase_service_role_key: str = field(default_factory=lambda: _env("SUPABASE_SERVICE_ROLE_KEY"))
    jwt_issuer: str = field(default_factory=lambda: _env("SUPABASE_JWT_ISSUER"))
    public_app_url: str = field(default_factory=lambda: _env("PUBLIC_APP_URL").rstrip("/"))
    oauth_providers: tuple[str, ...] = field(
        default_factory=lambda: _csv("OAUTH_PROVIDERS", "google,github,apple,facebook", lower=True)
    )
    admin_emails: tuple[str, ...] = field(default_factory=lambda: _csv("ADMIN_EMAILS", lower=True))
    allowed_origins: tuple[str, ...] = field(default_factory=lambda: _csv("ALLOWED_ORIGINS"))
    auth_required: bool = field(
        default_factory=lambda: _env("AUTH_REQUIRED").lower() in {"1", "true", "yes"}
    )
    # Leave AUTH_SECRET unset to have the server generate a random secret and
    # keep it in the database, so sessions survive restarts without a shared,
    # guessable default.
    auth_secret: str = field(default_factory=lambda: _env("AUTH_SECRET"))
    database_path: str = field(default_factory=lambda: _env("NOVEL_PLANNER_DB", "novel_planner.db"))

    @property
    def configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)

    @property
    def auth_mode(self) -> str:
        return "supabase" if self.configured else "builtin"

    @property
    def database_file(self) -> Path:
        return resolve_data_path(self.database_path)

    @property
    def resolved_jwt_issuer(self) -> str:
        return self.jwt_issuer or f"{self.supabase_url}/auth/v1"

    @property
    def jwks_url(self) -> str:
        return f"{self.resolved_jwt_issuer}/.well-known/jwks.json"

    def is_admin_email(self, email: str | None) -> bool:
        return bool(email and self.admin_emails and email.strip().lower() in self.admin_emails)


settings = Settings()
