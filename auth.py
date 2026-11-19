from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Depends, Header, HTTPException, status

from config import settings


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    email: str | None = None
    access_token: str | None = None


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(settings.jwks_url)


def _token_from_header(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[7:].strip()


def require_user(authorization: str | None = Header(default=None)) -> AuthenticatedUser:
    if not isinstance(authorization, str):
        authorization = None
    if not settings.configured:
        if not authorization:
            if not settings.auth_required:
                return AuthenticatedUser("local-development-user")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication is required.",
            )
        if authorization.startswith("Bearer "):
            from auth_store import auth_store
            try:
                claims = auth_store.verify_token(authorization[7:].strip())
                return AuthenticatedUser(claims["id"], claims["email"], authorization[7:].strip())
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=str(exc),
                ) from exc
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required.",
        )

    token = _token_from_header(authorization)
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
            issuer=settings.resolved_jwt_issuer,
        )
    except (jwt.PyJWTError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The authentication token is invalid or expired.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=401, detail="The token has no user identity.")
    email = claims.get("email")
    return AuthenticatedUser(user_id, email if isinstance(email, str) else None, token)


def require_admin(user: AuthenticatedUser = Depends(require_user)) -> AuthenticatedUser:
    if not settings.admin_emails or not user.email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required.")
    if user.email.lower() not in settings.admin_emails:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required.")
    return user
