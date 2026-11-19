from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    supabase_url: str = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_anon_key: str = os.getenv("SUPABASE_ANON_KEY", "")
    supabase_service_role_key: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    jwt_issuer: str = os.getenv("SUPABASE_JWT_ISSUER", "")
    public_app_url: str = os.getenv("PUBLIC_APP_URL", "").rstrip("/")
    oauth_providers: tuple[str, ...] = tuple(
        provider.strip().lower()
        for provider in os.getenv("OAUTH_PROVIDERS", "google,github,apple,facebook").split(",")
        if provider.strip()
    )
    admin_emails: tuple[str, ...] = tuple(
        email.strip().lower()
        for email in os.getenv("ADMIN_EMAILS", "").split(",")
        if email.strip()
    )
    allowed_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    )
    auth_required: bool = os.getenv("AUTH_REQUIRED", "").lower() in {"1", "true", "yes"}
    auth_secret: str = os.getenv("AUTH_SECRET", "novel-architect-local-development-secret")
    database_path: str = os.getenv("NOVEL_PLANNER_DB", "novel_planner.db")

    @property
    def configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)

    @property
    def resolved_jwt_issuer(self) -> str:
        return self.jwt_issuer or f"{self.supabase_url}/auth/v1"

    @property
    def jwks_url(self) -> str:
        return f"{self.resolved_jwt_issuer}/.well-known/jwks.json"


settings = Settings()
