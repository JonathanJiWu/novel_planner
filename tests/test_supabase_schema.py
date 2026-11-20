"""Apply supabase_schema.sql to a real PostgreSQL database and check its behaviour.

Runs when NOVEL_PLANNER_TEST_POSTGRES_DSN points at a disposable PostgreSQL
server (CI starts one); otherwise it is skipped. Supabase's ``auth`` schema is
replaced by a minimal stand-in with the pieces the schema uses.
"""
from __future__ import annotations

import os
import subprocess
import uuid

import pytest

from config import PROJECT_ROOT


DSN = os.getenv("NOVEL_PLANNER_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(
    not DSN,
    reason="set NOVEL_PLANNER_TEST_POSTGRES_DSN to a disposable PostgreSQL database to test the Supabase schema",
)

SUPABASE_STAND_IN = """
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;
grant usage on schema public, auth to authenticated;
grant execute on function auth.uid() to authenticated;
"""
GRANTS = "grant select, insert, update on public.projects, public.profiles to authenticated;"
ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"


def psql(sql: str, database: str | None = None) -> list[str]:
    target = DSN if database is None else DSN.rsplit("/", 1)[0] + f"/{database}"
    result = subprocess.run(
        ["psql", target, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-c", sql],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return [line for line in result.stdout.splitlines() if line]


@pytest.fixture
def database():
    name = f"novel_schema_{uuid.uuid4().hex[:12]}"
    psql(f"create database {name}")
    try:
        psql(SUPABASE_STAND_IN, name)
        yield name
    finally:
        psql(f"drop database {name} with (force)")


def apply_schema(database: str) -> None:
    psql((PROJECT_ROOT / "supabase_schema.sql").read_text(encoding="utf-8"), database)
    psql(GRANTS, database)


def as_user(user_id: str, sql: str) -> str:
    return (
        "begin; set local role authenticated; "
        f"select set_config('request.jwt.claim.sub', '{user_id}', true); {sql}; commit;"
    )


def test_schema_is_idempotent_and_creates_profiles(database):
    apply_schema(database)
    apply_schema(database)  # re-running after an upgrade must be safe
    psql(f"insert into auth.users (id, email, raw_user_meta_data) values ('{ALICE}', 'alice@example.com', '{{\"full_name\": \"Alice\"}}')", database)
    assert psql(f"select email, display_name from public.profiles where id = '{ALICE}'", database) == ["alice@example.com|Alice"]


def test_revisions_increment_and_guard_conditional_updates(database):
    apply_schema(database)
    psql(f"insert into auth.users (id, email) values ('{ALICE}', 'alice@example.com')", database)
    psql(f"insert into public.projects (owner_id, title, data) values ('{ALICE}', 'One', '{{}}')", database)
    assert psql(f"select revision from public.projects where owner_id = '{ALICE}'", database) == ["1"]

    psql(f"update public.projects set title = 'Two' where owner_id = '{ALICE}' and revision = 1", database)
    assert psql(f"select title, revision from public.projects where owner_id = '{ALICE}'", database) == ["Two|2"]

    stale = psql(
        f"with updated as (update public.projects set title = 'Stale' where owner_id = '{ALICE}' and revision = 1 returning 1) "
        "select count(*) from updated",
        database,
    )
    assert stale == ["0"]
    assert psql(f"select title from public.projects where owner_id = '{ALICE}'", database) == ["Two"]


def test_existing_rows_start_at_revision_one(database):
    # A project table created before revisions existed.
    psql(
        "create table public.projects (owner_id uuid primary key references auth.users(id) on delete cascade, "
        "title text not null, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), "
        "updated_at timestamptz not null default now())",
        database,
    )
    psql(f"insert into auth.users (id, email) values ('{ALICE}', 'alice@example.com')", database)
    psql(f"insert into public.projects (owner_id, title) values ('{ALICE}', 'Older project')", database)
    apply_schema(database)
    assert psql(f"select title, revision from public.projects where owner_id = '{ALICE}'", database) == ["Older project|1"]


def test_row_level_security_keeps_projects_private(database):
    apply_schema(database)
    psql(f"insert into auth.users (id, email) values ('{ALICE}', 'alice@example.com'), ('{BOB}', 'bob@example.com')", database)
    psql(as_user(ALICE, f"insert into public.projects (owner_id, title, data) values ('{ALICE}', 'Alice private', '{{}}')"), database)

    assert psql(as_user(BOB, "select count(*) from public.projects"), database)[-1] == "0"
    psql(as_user(BOB, f"update public.projects set title = 'Hijacked' where owner_id = '{ALICE}'"), database)
    assert psql(f"select title from public.projects where owner_id = '{ALICE}'", database) == ["Alice private"]

    inserted_for_someone_else = subprocess.run(
        ["psql", DSN.rsplit("/", 1)[0] + f"/{database}", "-v", "ON_ERROR_STOP=1", "-c",
         as_user(BOB, f"insert into public.projects (owner_id, title, data) values ('{ALICE}', 'x', '{{}}')")],
        capture_output=True,
        text=True,
    )
    assert inserted_for_someone_else.returncode != 0
    assert "row-level security" in inserted_for_someone_else.stderr
