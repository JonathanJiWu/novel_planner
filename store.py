from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from config import settings
from web_app import load_project_data, save_project_data


class ProjectStore:
    async def load(self, user_id: str, access_token: str | None = None) -> dict[str, Any]:
        if not settings.configured:
            return load_project_data()

        response = await self._request(
            "GET",
            "/rest/v1/projects",
            params={"owner_id": f"eq.{user_id}", "select": "data", "limit": "1"},
            access_token=access_token,
        )
        if response.status_code not in {200, 206}:
            raise RuntimeError(f"Supabase project read failed: {response.text}")
        rows = response.json()
        if not rows:
            return {"title": "My Novel", "answers": {}, "question_states": {}, "ideas": [],
                    "materials": [], "theme": "dark", "saved_at": None}
        return rows[0]["data"]

    async def save(
        self,
        user_id: str,
        data: dict[str, Any],
        access_token: str | None = None,
    ) -> dict[str, Any]:
        if not settings.configured:
            return save_project_data(data)

        clean_data = dict(data)
        clean_data["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        response = await self._request(
            "POST",
            "/rest/v1/projects",
            params={"on_conflict": "owner_id"},
            json={
                "owner_id": user_id,
                "title": clean_data["title"],
                "data": clean_data,
                "updated_at": clean_data["saved_at"],
            },
            headers={"Prefer": "resolution=merge-duplicates,return=representation"},
            access_token=access_token,
        )
        if response.status_code not in {200, 201}:
            raise RuntimeError(f"Supabase project save failed: {response.text}")
        return clean_data

    async def _request(
        self,
        method: str,
        path: str,
        access_token: str | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        headers = kwargs.pop("headers", {})
        headers.update(
            {
                "apikey": settings.supabase_anon_key,
                "Content-Type": "application/json",
            }
        )
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        async with httpx.AsyncClient(
            base_url=settings.supabase_url,
            timeout=httpx.Timeout(10.0),
            headers=headers,
        ) as client:
            return await client.request(method, path, **kwargs)
