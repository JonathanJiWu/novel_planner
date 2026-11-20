from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Depends, Header, HTTPException, status

from config import settings


LOCAL_USER_ID = "local-development-user"


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    email: str | None = None
    access_token: str | None = None


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(settings.jwks_url)


def _unauthorized(detail: str = "Authentication is required.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _token_from_header(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized()
    token = authorization[7:].strip()
    if not token:
        raise _unauthorized()
    return token


def bearer_token(authorization: str | None) -> str | None:
    """Return the bearer token from an Authorization header value, if any."""
    if isinstance(authorization, str) and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def require_user(authorization: str | None = Header(default=None)) -> AuthenticatedUser:
    if not isinstance(authorization, str):
        authorization = None
    if not settings.configured:
        if not authorization:
            if not settings.auth_required:
                # Single-user local development: every request shares one project.
                return AuthenticatedUser(LOCAL_USER_ID)
            raise _unauthorized()
        token = _token_from_header(authorization)
        from auth_store import get_auth_store

        try:
            claims = get_auth_store().verify_token(token)
        except ValueError as exc:
            raise _unauthorized(str(exc)) from exc
        return AuthenticatedUser(claims["id"], claims["email"], token)

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
        raise _unauthorized("The authentication token is invalid or expired.") from exc

    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise _unauthorized("The token has no user identity.")
    email = claims.get("email")
    return AuthenticatedUser(user_id, email if isinstance(email, str) else None, token)


def require_admin(user: AuthenticatedUser = Depends(require_user)) -> AuthenticatedUser:
    if not settings.is_admin_email(user.email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required.")
    return user
