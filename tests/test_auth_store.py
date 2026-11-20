"""SQLite account store: migrations, backups, sessions, and project revisions."""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import uuid
from datetime import timedelta
from pathlib import Path

import jwt
import pytest

import auth_store
from auth_store import SCHEMA_VERSION, AuthStore, _password_hash
from config import PROJECT_ROOT, resolve_data_path
from project_data import ConflictError


def legacy_database(path: Path) -> dict[str, str]:
    """Create a database exactly as the previous release did (no user_version, no revisions)."""
    salt = uuid.uuid4().hex
    user = {"id": str(uuid.uuid4()), "email": "early@example.com", "salt": salt}
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        create table users (id text primary key, email text not null unique, password_salt text not null,
                            password_hash text not null, created_at text not null);
        create table projects (owner_id text primary key, title text not null, data text not null,
                               created_at text not null, updated_at text not null);
        """
    )
    connection.execute(
        "insert into users values (?, ?, ?, ?, ?)",
        (user["id"], user["email"], salt, _password_hash("old-password-1", salt), "2026-11-01T00:00:00+00:00"),
    )
    connection.execute(
        "insert into projects values (?, ?, ?, ?, ?)",
        (
            user["id"],
            "Early Draft",
            json.dumps({"title": "Early Draft", "answers": {"story_seed": "kept"}, "ideas": [], "saved_at": "x"}),
            "2026-11-01T00:00:00+00:00",
            "2026-11-02T00:00:00+00:00",
        ),
    )
    connection.commit()
    connection.close()
    return user


def test_fresh_database_is_created_at_the_current_schema(configure, tmp_path):
    configure()
    store = AuthStore(tmp_path / "fresh.db")
    assert store.schema_version() == SCHEMA_VERSION
    assert not list(tmp_path.glob("fresh.db.backup-*"))  # nothing to back up


def test_legacy_database_is_backed_up_and_migrated_without_losing_data(configure, tmp_path):
    configure()
    path = tmp_path / "legacy.db"
    user = legacy_database(path)

    store = AuthStore(path)

    assert store.schema_version() == SCHEMA_VERSION
    backups = list(tmp_path.glob("legacy.db.backup-v0-*"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("select title from projects").fetchone()[0] == "Early Draft"
        assert backup.execute("pragma user_version").fetchone()[0] == 0

    project = store.load_project(user["id"])
    assert project["title"] == "Early Draft"
    assert project["answers"] == {"story_seed": "kept"}
    assert project["revision"] == 1
    assert project["saved_at"] == "2026-11-02T00:00:00+00:00"

    token, logged_in = store.login("early@example.com", "old-password-1")  # old password hashes still verify
    assert logged_in["id"] == user["id"]
    assert store.verify_token(token)["email"] == "early@example.com"

    # Running again is a no-op and does not create another backup.
    AuthStore(path)
    assert len(list(tmp_path.glob("legacy.db.backup-*"))) == 1


def test_failed_migration_rolls_back(configure, tmp_path, monkeypatch):
    configure()
    path = tmp_path / "legacy.db"
    legacy_database(path)

    def explode(connection):
        connection.execute("create table half_done (id integer)")
        raise RuntimeError("migration failed")

    monkeypatch.setattr(auth_store, "MIGRATIONS", auth_store.MIGRATIONS + ((3, "broken", explode),))
    monkeypatch.setattr(auth_store, "SCHEMA_VERSION", 3)
    with pytest.raises(RuntimeError, match="migration failed"):
        AuthStore(path)
    with sqlite3.connect(path) as connection:
        assert connection.execute("pragma user_version").fetchone()[0] == 0
        tables = {row[0] for row in connection.execute("select name from sqlite_master where type = 'table'")}
    assert "half_done" not in tables
    assert "sessions" not in tables  # earlier steps of the same run were rolled back too


def test_database_from_a_newer_release_is_refused(configure, tmp_path):
    configure()
    path = tmp_path / "future.db"
    with sqlite3.connect(path) as connection:
        connection.execute(f"pragma user_version = {SCHEMA_VERSION + 1}")
    with pytest.raises(RuntimeError, match="newer than this application supports"):
        AuthStore(path)


def test_generated_signing_secret_survives_restarts(configure, tmp_path):
    configure(auth_secret="")
    path = tmp_path / "accounts.db"
    token, _user = AuthStore(path).register("writer@example.com", "long-enough-password")
    assert AuthStore(path).verify_token(token)["email"] == "writer@example.com"


def test_configured_secret_is_used_for_signing(configure, tmp_path):
    configure(auth_secret="operator-provided-secret-with-enough-length")
    token, _user = AuthStore(tmp_path / "accounts.db").register("writer@example.com", "long-enough-password")
    assert jwt.decode(token, "operator-provided-secret-with-enough-length", algorithms=["HS256"])["email"] == "writer@example.com"


def test_forged_or_expired_sessions_are_rejected(configure, tmp_path, monkeypatch):
    configure()
    store = AuthStore(tmp_path / "accounts.db")
    token, user = store.register("writer@example.com", "long-enough-password")
    claims = jwt.decode(token, options={"verify_signature": False})

    forged = jwt.encode({**claims}, "novel-architect-local-development-secret", algorithm="HS256")
    with pytest.raises(ValueError):
        store.verify_token(forged)  # the old hard-coded default secret no longer works

    monkeypatch.setattr(auth_store, "SESSION_LIFETIME", timedelta(seconds=-1))
    expired_token = store.create_token(user["id"], user["email"])
    with pytest.raises(ValueError):
        store.verify_token(expired_token)


def test_password_reset_signs_out_existing_sessions(configure, tmp_path):
    configure()
    store = AuthStore(tmp_path / "accounts.db")
    token, _user = store.register("writer@example.com", "long-enough-password")
    store.set_password("writer@example.com", "a-new-password")
    with pytest.raises(ValueError):
        store.verify_token(token)
    with pytest.raises(ValueError):
        store.login("writer@example.com", "long-enough-password")
    assert store.login("writer@example.com", "a-new-password")[1]["email"] == "writer@example.com"


def test_reserved_addresses_need_the_operator_path(configure, tmp_path):
    configure(admin_emails=("owner@example.com",))
    store = AuthStore(tmp_path / "accounts.db")
    with pytest.raises(auth_store.ReservedEmailError):
        store.register("owner@example.com", "long-enough-password")
    _token, user = store.register("owner@example.com", "long-enough-password", allow_reserved=True)
    assert user["email"] == "owner@example.com"


def test_save_project_enforces_revisions(configure, tmp_path):
    configure()
    store = AuthStore(tmp_path / "accounts.db")
    assert store.save_project("owner", {"title": "One"}, base_revision=0)["revision"] == 1
    assert store.save_project("owner", {"title": "Two"}, base_revision=1)["revision"] == 2
    with pytest.raises(ConflictError) as conflict:
        store.save_project("owner", {"title": "Stale"}, base_revision=1)
    assert conflict.value.current["title"] == "Two"
    assert conflict.value.current["revision"] == 2
    with pytest.raises(ConflictError):
        store.save_project("someone-new", {"title": "Thinks it exists"}, base_revision=3)
    stored = store.load_project("owner")
    assert stored["title"] == "Two"
    assert "revision" not in json.loads(
        sqlite3.connect(tmp_path / "accounts.db").execute("select data from projects").fetchone()[0]
    )


def test_importing_the_store_does_not_create_a_database(tmp_path):
    # Regression: importing auth_store created novel_planner.db in the current directory.
    script = "import app, auth_store, store, web_app"
    subprocess.run([sys.executable, "-c", script], cwd=tmp_path, check=True, env={"PYTHONPATH": str(PROJECT_ROOT)})
    assert list(tmp_path.iterdir()) == []


def test_relative_database_paths_are_anchored_at_the_project_root():
    assert resolve_data_path("novel_planner.db") == PROJECT_ROOT / "novel_planner.db"
    assert resolve_data_path("/var/data/novel_planner.db") == Path("/var/data/novel_planner.db")
