"""Supabase mode against an in-memory PostgREST stand-in (no live Supabase project is needed).

The fake implements the behaviour this app relies on: row filters, insert
conflicts, upserts, and the ``projects`` trigger that increments ``revision``.
It cannot prove the real database is configured correctly; supabase_schema.sql
must still be applied to the Supabase project.
"""
from __future__ import annotations

import asyncio
import json
import time
from urllib.parse import parse_qs

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException

import auth
import store as store_module
from project_data import ConflictError


class FakePostgrest:
    def __init__(self) -> None:
        self.projects: dict[str, dict] = {}
        self.profiles = {"user-a": {"id": "user-a", "email": "a@example.com"}}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        query = {key: values[0] for key, values in parse_qs(request.url.query.decode()).items()}
        path = request.url.path
        if path == "/rest/v1/profiles":
            ids = query["id"][4:-1].split(",")
            return httpx.Response(200, json=[self.profiles[i] for i in ids if i in self.profiles])
        owner = query.get("owner_id", "")[3:] if "owner_id" in query else None
        if request.method == "GET":
            rows = [self.projects[owner]] if owner in self.projects else ([] if owner else list(self.projects.values()))
            columns = query.get("select", "").split(",")
            return httpx.Response(200, json=[{key: row[key] for key in columns if key in row} for row in rows])
        if request.method == "POST":
            body = json.loads(request.content)
            existing = self.projects.get(body["owner_id"])
            if existing and "on_conflict" not in query:
                return httpx.Response(409, json={"code": "23505", "message": "duplicate key"})
            if existing:
                existing.update(body)
                existing["revision"] += 1  # the update trigger
                return httpx.Response(200, json=[existing])
            row = {**body, "revision": 1, "created_at": body["updated_at"]}
            self.projects[body["owner_id"]] = row
            return httpx.Response(201, json=[row])
        if request.method == "PATCH":
            row = self.projects.get(owner)
            if row is None or str(row["revision"]) != query["revision"][3:]:
                return httpx.Response(200, json=[])
            row.update(json.loads(request.content))
            row["revision"] += 1
            return httpx.Response(200, json=[row])
        if request.method == "DELETE":
            row = self.projects.pop(owner, None)
            return httpx.Response(200, json=[row] if row else [])
        return httpx.Response(405)


@pytest.fixture
def supabase(configure, monkeypatch):
    configure(
        supabase_url="https://example.supabase.co",
        supabase_anon_key="anon-key",
        supabase_service_role_key="service-key",
    )
    fake = FakePostgrest()
    monkeypatch.setattr(store_module.ProjectStore, "_transport", lambda self: httpx.MockTransport(fake))
    return fake


def run(coroutine):
    return asyncio.run(coroutine)


def test_new_user_gets_an_empty_project(supabase):
    project = run(store_module.ProjectStore().load("user-a", "user-token"))
    assert project["title"] == "My Novel"
    assert project["revision"] == 0
    request = supabase.requests[-1]
    assert request.headers["authorization"] == "Bearer user-token"
    assert request.headers["apikey"] == "anon-key"


def test_saves_use_revision_checks(supabase):
    projects = store_module.ProjectStore()
    first = run(projects.save("user-a", {"title": "One", "answers": {}}, "token", base_revision=0))
    assert first["revision"] == 1
    assert supabase.requests[-1].method == "POST"

    second = run(projects.save("user-a", {"title": "Two"}, "token", base_revision=1))
    assert second["revision"] == 2
    assert supabase.requests[-1].method == "PATCH"
    assert "revision=eq.1" in str(supabase.requests[-1].url)

    with pytest.raises(ConflictError) as stale:
        run(projects.save("user-a", {"title": "Stale"}, "token", base_revision=1))
    assert stale.value.current["title"] == "Two"
    assert stale.value.current["revision"] == 2

    with pytest.raises(ConflictError):
        run(projects.save("user-a", {"title": "Thinks it is new"}, "token", base_revision=0))

    legacy = run(projects.save("user-a", {"title": "Old client"}, "token", base_revision=None))
    assert legacy["revision"] == 3
    loaded = run(projects.load("user-a", "token"))
    assert loaded["title"] == "Old client"
    assert "revision" not in supabase.projects["user-a"]["data"]


def test_administration_uses_the_service_role_and_omits_project_bodies(supabase):
    projects = store_module.ProjectStore()
    run(projects.save("user-a", {"title": "Listed"}, "token", base_revision=0))
    listed = run(projects.list_projects())
    assert listed == [
        {
            "owner_id": "user-a",
            "title": "Listed",
            "created_at": listed[0]["created_at"],
            "updated_at": listed[0]["updated_at"],
            "revision": 1,
            "email": "a@example.com",
        }
    ]
    list_request = next(r for r in supabase.requests if r.url.path == "/rest/v1/projects" and r.method == "GET")
    assert list_request.headers["authorization"] == "Bearer service-key"
    assert "data" not in parse_qs(list_request.url.query.decode())["select"][0].split(",")
    assert run(projects.delete_project("user-a")) is True
    assert run(projects.delete_project("user-a")) is False


def test_network_failures_become_storage_errors(configure, monkeypatch):
    configure(supabase_url="https://example.supabase.co", supabase_anon_key="anon-key")

    def unreachable(request):
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setattr(store_module.ProjectStore, "_transport", lambda self: httpx.MockTransport(unreachable))
    with pytest.raises(RuntimeError, match="Supabase request failed"):
        run(store_module.ProjectStore().load("user-a", "token"))


@pytest.fixture
def signing_key(configure, monkeypatch):
    configure(supabase_url="https://example.supabase.co", supabase_anon_key="anon-key")
    private_key = ec.generate_private_key(ec.SECP256R1())

    class FakeJwks:
        def get_signing_key_from_jwt(self, token):
            return type("Key", (), {"key": private_key.public_key()})()

    monkeypatch.setattr(auth, "_jwks_client", lambda: FakeJwks())
    return private_key


def supabase_token(key, **overrides):
    claims = {
        "sub": "user-a",
        "email": "a@example.com",
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 600,
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="ES256")


def test_supabase_tokens_are_verified(signing_key):
    user = auth.require_user(f"Bearer {supabase_token(signing_key)}")
    assert (user.user_id, user.email) == ("user-a", "a@example.com")

    for bad in (
        supabase_token(signing_key, aud="anon"),
        supabase_token(signing_key, iss="https://attacker.example/auth/v1"),
        supabase_token(signing_key, exp=int(time.time()) - 10),
        supabase_token(ec.generate_private_key(ec.SECP256R1())),
    ):
        with pytest.raises(HTTPException) as rejected:
            auth.require_user(f"Bearer {bad}")
        assert rejected.value.status_code == 401
