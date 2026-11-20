from __future__ import annotations

import functools
from datetime import datetime, timezone
from typing import Any

import httpx
from anyio import to_thread

from auth_store import get_auth_store
from config import settings
from project_data import ConflictError, new_project_data, storable


class ProjectStore:
    """Project persistence for the production API.

    Built-in mode stores projects in SQLite (see ``auth_store``); Supabase mode
    stores them in ``public.projects`` through PostgREST. Both enforce the same
    revision check, so a stale browser tab cannot silently overwrite newer work.
    """

    async def load(self, user_id: str, access_token: str | None = None) -> dict[str, Any]:
        if not settings.configured:
            data = await to_thread.run_sync(get_auth_store().load_project, user_id)
            # A user who has never saved starts with an empty project. (Never fall
            # back to a file on the server: that would show one person's work to
            # every new account.)
            return data if data is not None else new_project_data()

        response = await self._request(
            "GET",
            "/rest/v1/projects",
            params={"owner_id": f"eq.{user_id}", "select": "data,revision,updated_at", "limit": "1"},
            access_token=access_token,
        )
        if response.status_code not in {200, 206}:
            raise RuntimeError(f"Supabase project read failed ({response.status_code}): {response.text}")
        rows = response.json()
        if not rows:
            return new_project_data()
        return self._row_to_project(rows[0])

    async def save(
        self,
        user_id: str,
        data: dict[str, Any],
        access_token: str | None = None,
        base_revision: int | None = None,
    ) -> dict[str, Any]:
        if not settings.configured:
            return await to_thread.run_sync(
                functools.partial(get_auth_store().save_project, user_id, data, base_revision)
            )

        document = storable(data)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        body = {"title": document["title"], "data": document, "updated_at": now}
        if base_revision is None:
            # Clients that predate revision tracking: last write wins.
            response = await self._request(
                "POST",
                "/rest/v1/projects",
                params={"on_conflict": "owner_id"},
                json={"owner_id": user_id, **body},
                headers={"Prefer": "resolution=merge-duplicates,return=representation"},
                access_token=access_token,
            )
        elif base_revision == 0:
            response = await self._request(
                "POST",
                "/rest/v1/projects",
                json={"owner_id": user_id, **body},
                headers={"Prefer": "return=representation"},
                access_token=access_token,
            )
            if response.status_code == 409:
                raise ConflictError(await self.load(user_id, access_token))
        else:
            # The update only matches while the stored revision is still the one
            # the client edited; a database trigger increments it on every update.
            response = await self._request(
                "PATCH",
                "/rest/v1/projects",
                params={"owner_id": f"eq.{user_id}", "revision": f"eq.{base_revision}"},
                json=body,
                headers={"Prefer": "return=representation"},
                access_token=access_token,
            )
        if response.status_code not in {200, 201}:
            raise RuntimeError(f"Supabase project save failed ({response.status_code}): {response.text}")
        rows = response.json()
        if not rows:
            raise ConflictError(await self.load(user_id, access_token))
        row = rows[0]
        saved = dict(document)
        saved["saved_at"] = row.get("updated_at") or now
        saved["revision"] = int(row.get("revision") or 1)
        return saved

    async def list_projects(self) -> list[dict[str, Any]]:
        if not settings.configured:
            return await to_thread.run_sync(get_auth_store().list_projects)
        if not settings.supabase_service_role_key:
            raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is required for database administration.")
        response = await self._request(
            "GET",
            "/rest/v1/projects",
            params={"select": "owner_id,title,created_at,updated_at,revision", "order": "updated_at.desc"},
            service_role=True,
        )
        if response.status_code not in {200, 206}:
            raise RuntimeError(f"Supabase project administration read failed ({response.status_code}): {response.text}")
        projects = response.json()
        emails = await self._profile_emails([project["owner_id"] for project in projects])
        for project in projects:
            project["email"] = emails.get(project["owner_id"])
        return projects

    async def delete_project(self, owner_id: str) -> bool:
        if not settings.configured:
            return await to_thread.run_sync(get_auth_store().delete_project, owner_id)
        if not settings.supabase_service_role_key:
            raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is required for database administration.")
        response = await self._request(
            "DELETE",
            "/rest/v1/projects",
            params={"owner_id": f"eq.{owner_id}"},
            headers={"Prefer": "return=representation"},
            service_role=True,
        )
        if response.status_code not in {200, 204}:
            raise RuntimeError(f"Supabase project delete failed ({response.status_code}): {response.text}")
        return bool(response.content and response.json())

    async def health_check(self) -> None:
        if not settings.configured:
            await to_thread.run_sync(get_auth_store().health_check)

    async def _profile_emails(self, owner_ids: list[str]) -> dict[str, str | None]:
        emails: dict[str, str | None] = {}
        for start in range(0, len(owner_ids), 100):
            batch = owner_ids[start:start + 100]
            response = await self._request(
                "GET",
                "/rest/v1/profiles",
                params={"select": "id,email", "id": f"in.({','.join(batch)})"},
                service_role=True,
            )
            if response.status_code in {200, 206}:
                emails.update({row["id"]: row.get("email") for row in response.json()})
        return emails

    @staticmethod
    def _row_to_project(row: dict[str, Any]) -> dict[str, Any]:
        data = dict(row.get("data") or {})
        data["revision"] = int(row.get("revision") or 1)
        data["saved_at"] = row.get("updated_at") or data.get("saved_at")
        return data

    async def _request(
        self,
        method: str,
        path: str,
        access_token: str | None = None,
        service_role: bool = False,
        **kwargs: Any,
    ) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}))
        headers.update(
            {
                "apikey": settings.supabase_service_role_key if service_role else settings.supabase_anon_key,
                "Content-Type": "application/json",
            }
        )
        if service_role:
            headers["Authorization"] = f"Bearer {settings.supabase_service_role_key}"
        elif access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        try:
            async with httpx.AsyncClient(
                base_url=settings.supabase_url,
                timeout=httpx.Timeout(10.0),
                headers=headers,
                transport=self._transport(),
            ) as client:
                return await client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Supabase request failed: {exc}") from exc

    def _transport(self) -> httpx.AsyncBaseTransport | None:
        """Hook for tests to substitute an in-memory transport."""
        return None
