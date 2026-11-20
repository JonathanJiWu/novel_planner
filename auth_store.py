"""SQLite persistence for built-in accounts, sessions, and projects.

Used when Supabase is not configured. Schema changes are applied by numbered
migrations tracked with ``PRAGMA user_version``; before an existing database is
migrated, a backup copy is written next to it so an upgrade can never destroy
accounts or projects.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import sqlite3
import threading
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

import jwt

import config
from project_data import DEFAULT_TITLE, ConflictError, new_project_data, storable


logger = logging.getLogger("novel_architect.auth_store")

SESSION_LIFETIME = timedelta(days=30)
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 200
MAX_EMAIL_LENGTH = 320
INVALID_SESSION = "Your session has expired or was signed out. Please log in again."


class ReservedEmailError(ValueError):
    """The address belongs to a configured administrator and cannot self-register."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _password_hash(password: str, salt: str) -> str:
    # Parameters and salt encoding are unchanged from earlier releases so
    # existing password hashes keep verifying.
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    ).hex()


# ---------------------------------------------------------------------------
# Migrations. Append new steps; never edit a step that has shipped.
# Each step runs inside the migration transaction, so use connection.execute
# (executescript would commit implicitly).
# ---------------------------------------------------------------------------


def _migration_1_baseline(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        create table if not exists users (
            id text primary key,
            email text not null unique,
            password_salt text not null,
            password_hash text not null,
            created_at text not null
        )
        """
    )
    connection.execute(
        """
        create table if not exists projects (
            owner_id text primary key,
            title text not null,
            data text not null,
            created_at text not null,
            updated_at text not null
        )
        """
    )


def _migration_2_revisions_and_sessions(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("pragma table_info(projects)")}
    if "revision" not in columns:
        connection.execute("alter table projects add column revision integer not null default 1")
    connection.execute(
        """
        create table if not exists sessions (
            id text primary key,
            user_id text not null references users(id) on delete cascade,
            created_at text not null,
            expires_at text not null,
            revoked_at text
        )
        """
    )
    connection.execute("create index if not exists sessions_user_id on sessions(user_id)")
    connection.execute(
        "create table if not exists app_settings (key text primary key, value text not null)"
    )


MIGRATIONS: tuple[tuple[int, str, Callable[[sqlite3.Connection], None]], ...] = (
    (1, "accounts and projects", _migration_1_baseline),
    (2, "project revisions, revocable sessions, server settings", _migration_2_revisions_and_sessions),
)
SCHEMA_VERSION = MIGRATIONS[-1][0]


class AuthStore:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else config.settings.database_file
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()
        self._secret = self._load_or_create_secret()

    # -- connections ---------------------------------------------------------

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("pragma foreign_keys = on")
        connection.execute("pragma busy_timeout = 10000")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as connection:
            connection.execute("begin immediate")
            try:
                yield connection
            except BaseException:
                connection.execute("rollback")
                raise
            connection.execute("commit")

    # -- schema --------------------------------------------------------------

    def schema_version(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("pragma user_version").fetchone()[0])

    def migrate(self) -> int:
        with self._connect() as connection:
            current = int(connection.execute("pragma user_version").fetchone()[0])
            has_tables = connection.execute(
                "select count(*) from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            ).fetchone()[0]
        if current > SCHEMA_VERSION:
            raise RuntimeError(
                f"The database at {self.path} uses schema version {current}, which is newer than "
                f"this application supports ({SCHEMA_VERSION}). Upgrade the application instead."
            )
        if current == SCHEMA_VERSION:
            return current
        if has_tables:
            self.backup(f"v{current}")

        with self._transaction() as connection:
            # Re-read under the write lock in case another process migrated first.
            current = int(connection.execute("pragma user_version").fetchone()[0])
            for version, description, apply in MIGRATIONS:
                if version > current:
                    apply(connection)
                    connection.execute(f"pragma user_version = {version}")
                    logger.info("Applied database migration %s: %s", version, description)
        return SCHEMA_VERSION

    def backup(self, label: str = "manual") -> Path:
        stamp = _now().strftime("%Y%m%dT%H%M%S%fZ")
        target = self.path.with_name(f"{self.path.name}.backup-{label}-{stamp}")
        with self._connect() as source, closing(sqlite3.connect(target)) as destination:
            source.backup(destination)
        logger.warning("Saved a database backup at %s", target)
        return target

    def health_check(self) -> None:
        with self._connect() as connection:
            connection.execute("select 1").fetchone()

    def _load_or_create_secret(self) -> str:
        if config.settings.auth_secret:
            return config.settings.auth_secret
        with self._transaction() as connection:
            row = connection.execute("select value from app_settings where key = 'auth_secret'").fetchone()
            if row is not None:
                return str(row["value"])
            value = secrets.token_urlsafe(48)
            connection.execute("insert into app_settings (key, value) values ('auth_secret', ?)", (value,))
            logger.info("Generated a signing secret for built-in sessions and stored it in the database.")
            return value

    # -- accounts ------------------------------------------------------------

    @staticmethod
    def normalize_email(email: str) -> str:
        return email.strip().lower()

    @staticmethod
    def _validate_credentials(email: str, password: str) -> None:
        if not email or len(email) > MAX_EMAIL_LENGTH or not EMAIL_PATTERN.match(email):
            raise ValueError("Enter a valid email address.")
        if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
            raise ValueError(
                f"Password must be between {MIN_PASSWORD_LENGTH} and {MAX_PASSWORD_LENGTH} characters."
            )

    def register(
        self,
        email: str,
        password: str,
        *,
        allow_reserved: bool = False,
    ) -> tuple[str, dict[str, str]]:
        normalized = self.normalize_email(email)
        self._validate_credentials(normalized, password)
        if not allow_reserved and config.settings.is_admin_email(normalized):
            raise ReservedEmailError(
                "This email address is reserved for a site administrator. "
                "Administrator accounts are created on the server with `python manage.py create-user`."
            )
        user_id = str(uuid.uuid4())
        salt = uuid.uuid4().hex
        password_hash = _password_hash(password, salt)
        try:
            with self._transaction() as connection:
                connection.execute(
                    "insert into users (id, email, password_salt, password_hash, created_at) values (?, ?, ?, ?, ?)",
                    (user_id, normalized, salt, password_hash, _iso(_now())),
                )
                token = self._create_session(connection, user_id, normalized)
        except sqlite3.IntegrityError as exc:
            raise ValueError("An account with this email already exists.") from exc
        return token, {"id": user_id, "email": normalized}

    def login(self, email: str, password: str) -> tuple[str, dict[str, str]]:
        normalized = self.normalize_email(email)
        with self._connect() as connection:
            row = connection.execute(
                "select id, email, password_salt, password_hash from users where email = ?",
                (normalized,),
            ).fetchone()
        if row is None:
            # Spend the same effort as a real check so response timing does not
            # reveal which addresses have accounts.
            _password_hash(password, "0" * 32)
            raise ValueError("Invalid email or password.")
        candidate = _password_hash(password, row["password_salt"])
        if not hmac.compare_digest(candidate, row["password_hash"]):
            raise ValueError("Invalid email or password.")
        with self._transaction() as connection:
            token = self._create_session(connection, row["id"], row["email"])
        return token, {"id": row["id"], "email": row["email"]}

    def set_password(self, email: str, password: str) -> None:
        normalized = self.normalize_email(email)
        self._validate_credentials(normalized, password)
        salt = uuid.uuid4().hex
        password_hash = _password_hash(password, salt)
        with self._transaction() as connection:
            row = connection.execute("select id from users where email = ?", (normalized,)).fetchone()
            if row is None:
                raise ValueError(f"No account exists for {normalized}.")
            connection.execute(
                "update users set password_salt = ?, password_hash = ? where id = ?",
                (salt, password_hash, row["id"]),
            )
            connection.execute("delete from sessions where user_id = ?", (row["id"],))

    def list_users(self) -> list[dict[str, str]]:
        with self._connect() as connection:
            rows = connection.execute("select id, email, created_at from users order by created_at").fetchall()
        return [dict(row) for row in rows]

    # -- sessions ------------------------------------------------------------

    def _create_session(self, connection: sqlite3.Connection, user_id: str, email: str) -> str:
        now = _now()
        expires = now + SESSION_LIFETIME
        session_id = secrets.token_urlsafe(24)
        connection.execute(
            "delete from sessions where user_id = ? and (expires_at <= ? or revoked_at is not null)",
            (user_id, _iso(now)),
        )
        connection.execute(
            "insert into sessions (id, user_id, created_at, expires_at) values (?, ?, ?, ?)",
            (session_id, user_id, _iso(now), _iso(expires)),
        )
        return jwt.encode(
            {
                "sub": user_id,
                "email": email,
                "sid": session_id,
                "iat": int(now.timestamp()),
                "exp": int(expires.timestamp()),
            },
            self._secret,
            algorithm="HS256",
        )

    def create_token(self, user_id: str, email: str) -> str:
        with self._transaction() as connection:
            return self._create_session(connection, user_id, email)

    def verify_token(self, token: str) -> dict[str, str]:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                options={"require": ["exp", "sub", "sid"]},
            )
        except jwt.PyJWTError as exc:
            raise ValueError(INVALID_SESSION) from exc
        user_id, session_id = claims.get("sub"), claims.get("sid")
        if not isinstance(user_id, str) or not isinstance(session_id, str):
            raise ValueError(INVALID_SESSION)
        with self._connect() as connection:
            row = connection.execute(
                """
                select users.id, users.email, sessions.expires_at, sessions.revoked_at
                from sessions join users on users.id = sessions.user_id
                where sessions.id = ? and sessions.user_id = ?
                """,
                (session_id, user_id),
            ).fetchone()
        if (
            row is None
            or row["revoked_at"] is not None
            or datetime.fromisoformat(row["expires_at"]) <= _now()
        ):
            raise ValueError(INVALID_SESSION)
        return {"id": row["id"], "email": row["email"], "session_id": session_id}

    def logout(self, token: str) -> None:
        """Revoke the session behind ``token``. Unknown or invalid tokens are ignored."""
        try:
            claims = jwt.decode(token, self._secret, algorithms=["HS256"], options={"verify_exp": False})
        except jwt.PyJWTError:
            return
        session_id = claims.get("sid")
        if isinstance(session_id, str):
            with self._transaction() as connection:
                connection.execute(
                    "update sessions set revoked_at = ? where id = ? and revoked_at is null",
                    (_iso(_now()), session_id),
                )

    # -- projects ------------------------------------------------------------

    @staticmethod
    def _row_to_project(row: sqlite3.Row) -> dict[str, Any]:
        data = json.loads(row["data"])
        data["revision"] = int(row["revision"])
        data["saved_at"] = row["updated_at"]
        return data

    def load_project(self, user_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "select data, revision, updated_at from projects where owner_id = ?",
                (user_id,),
            ).fetchone()
        return None if row is None else self._row_to_project(row)

    def save_project(
        self,
        user_id: str,
        data: dict[str, Any],
        base_revision: int | None = None,
    ) -> dict[str, Any]:
        """Store ``data``; reject it if ``base_revision`` is not the current revision.

        ``base_revision`` of None skips the check (clients that predate revision
        tracking). 0 means the client believes the project has never been saved.
        """
        document = storable(data)
        payload = json.dumps(document, ensure_ascii=False)
        title = str(document.get("title") or DEFAULT_TITLE)
        now = _iso(_now())
        with self._transaction() as connection:
            row = connection.execute(
                "select data, revision, updated_at from projects where owner_id = ?",
                (user_id,),
            ).fetchone()
            current_revision = int(row["revision"]) if row is not None else 0
            if base_revision is not None and base_revision != current_revision:
                raise ConflictError(self._row_to_project(row) if row is not None else new_project_data())
            if row is None:
                revision = 1
                connection.execute(
                    """
                    insert into projects (owner_id, title, data, created_at, updated_at, revision)
                    values (?, ?, ?, ?, ?, ?)
                    """,
                    (user_id, title, payload, now, now, revision),
                )
            else:
                revision = current_revision + 1
                connection.execute(
                    "update projects set title = ?, data = ?, updated_at = ?, revision = ? where owner_id = ?",
                    (title, payload, now, revision, user_id),
                )
        saved = dict(document)
        saved["saved_at"] = now
        saved["revision"] = revision
        return saved

    def list_projects(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                select projects.owner_id, users.email, projects.title, projects.created_at,
                       projects.updated_at, projects.revision
                from projects left join users on users.id = projects.owner_id
                order by projects.updated_at desc
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_project(self, owner_id: str) -> bool:
        with self._transaction() as connection:
            cursor = connection.execute("delete from projects where owner_id = ?", (owner_id,))
            return cursor.rowcount > 0


_store: AuthStore | None = None
_store_lock = threading.Lock()


def get_auth_store() -> AuthStore:
    """Return the process-wide store, opening (and migrating) the database on first use."""
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = AuthStore()
    return _store


def reset_auth_store() -> None:
    """Forget the cached store (used by tests and after configuration changes)."""
    global _store
    with _store_lock:
        _store = None
