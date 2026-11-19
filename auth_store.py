from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt

from config import settings


class AuthStore:
    def __init__(self, path: Path | None = None) -> None:
        if path is None:
            path = Path(settings.database_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                create table if not exists users (
                    id text primary key,
                    email text not null unique,
                    password_salt text not null,
                    password_hash text not null,
                    created_at text not null
                );
                create table if not exists projects (
                    owner_id text primary key,
                    title text not null,
                    data text not null,
                    created_at text not null,
                    updated_at text not null
                );
                """
            )

    @staticmethod
    def _normalize_email(email: str) -> str:
        return email.strip().lower()

    @staticmethod
    def _password_hash(password: str, salt: str) -> str:
        return hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=2**14,
            r=8,
            p=1,
            dklen=64,
        ).hex()

    def register(self, email: str, password: str) -> tuple[str, dict[str, str]]:
        normalized = self._normalize_email(email)
        if not normalized or "@" not in normalized or len(normalized) > 320:
            raise ValueError("Enter a valid email address.")
        if len(password) < 8 or len(password) > 200:
            raise ValueError("Password must be between 8 and 200 characters.")

        user_id = str(uuid.uuid4())
        salt = uuid.uuid4().hex
        password_hash = self._password_hash(password, salt)
        created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        try:
            with self._connect() as connection:
                connection.execute(
                    "insert into users (id, email, password_salt, password_hash, created_at) values (?, ?, ?, ?, ?)",
                    (user_id, normalized, salt, password_hash, created_at),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("An account with this email already exists.") from exc

        token = self.create_token(user_id, normalized)
        return token, {"id": user_id, "email": normalized}

    def login(self, email: str, password: str) -> tuple[str, dict[str, str]]:
        normalized = self._normalize_email(email)
        with self._connect() as connection:
            row = connection.execute(
                "select id, email, password_salt, password_hash from users where email = ?",
                (normalized,),
            ).fetchone()
        if not row:
            raise ValueError("Invalid email or password.")
        candidate = self._password_hash(password, row["password_salt"])
        if not hmac.compare_digest(candidate, row["password_hash"]):
            raise ValueError("Invalid email or password.")

        token = self.create_token(row["id"], row["email"])
        return token, {"id": row["id"], "email": row["email"]}

    def create_token(self, user_id: str, email: str) -> str:
        now = datetime.now(timezone.utc)
        return jwt.encode(
            {
                "sub": user_id,
                "email": email,
                "iat": int(now.timestamp()),
                "exp": int((now + timedelta(days=30)).timestamp()),
            },
            settings.auth_secret,
            algorithm="HS256",
        )

    def verify_token(self, token: str) -> dict[str, str]:
        try:
            claims = jwt.decode(token, settings.auth_secret, algorithms=["HS256"])
        except jwt.PyJWTError as exc:
            raise ValueError("The session is invalid or expired.") from exc
        user_id = claims.get("sub")
        email = claims.get("email")
        if not isinstance(user_id, str) or not isinstance(email, str):
            raise ValueError("The session has no valid user identity.")
        return {"id": user_id, "email": email}

    def load_project(self, user_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "select data from projects where owner_id = ?",
                (user_id,),
            ).fetchone()
        if not row:
            return None
        import json
        return json.loads(row["data"])

    def save_project(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        import json
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._connect() as connection:
            connection.execute(
                """
                insert into projects (owner_id, title, data, created_at, updated_at)
                values (?, ?, ?, ?, ?)
                on conflict(owner_id) do update set
                    title=excluded.title,
                    data=excluded.data,
                    updated_at=excluded.updated_at
                """,
                (user_id, str(data.get("title", "My Novel")), json.dumps(data), now, now),
            )
        clean_data = dict(data)
        clean_data["saved_at"] = now
        return clean_data

    def list_projects(self) -> list[dict[str, Any]]:
        import json
        with self._connect() as connection:
            rows = connection.execute(
                "select owner_id, title, data, created_at, updated_at from projects order by updated_at desc"
            ).fetchall()
        return [
            {
                "owner_id": row["owner_id"],
                "title": row["title"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "data": json.loads(row["data"]),
            }
            for row in rows
        ]

    def delete_project(self, owner_id: str) -> None:
        with self._connect() as connection:
            connection.execute("delete from projects where owner_id = ?", (owner_id,))


auth_store = AuthStore()
