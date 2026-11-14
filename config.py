from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    supabase_url: str = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_anon_key: str = os.getenv("SUPABASE_ANON_KEY", "")
    jwt_issuer: str = os.getenv("SUPABASE_JWT_ISSUER", "")
    allowed_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    )
    auth_required: bool = os.getenv("AUTH_REQUIRED", "").lower() in {"1", "true", "yes"}

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
