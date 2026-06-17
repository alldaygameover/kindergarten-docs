import json
import os
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException, Request

DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"
EVENTS_FILENAME = "kg-calendar-events.json"
MIME_TYPE = "application/json"


def use_google_drive_events() -> bool:
    mode = os.getenv("STORAGE_MODE", "google_drive").strip().lower()
    return mode in ("google_drive", "google-drive")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_store() -> dict:
    return {"version": 1, "updated_at": _now_iso(), "events": []}


def format_event_for_api(event: dict) -> dict:
    return {
        "id": event["id"],
        "title": event.get("title", "未命名活動"),
        "event_date": event.get("event_date"),
        "end_date": event.get("end_date"),
        "event_time": event.get("event_time"),
        "location": event.get("location"),
        "description": event.get("description"),
        "category": event.get("category", "other"),
        "notes": event.get("notes"),
        "filename": event.get("source_filename") or event.get("filename") or "手動新增",
    }


async def _refresh_access_token(request: Request) -> str:
    refresh_token = request.session.get("google_refresh_token")
    if not refresh_token:
        raise HTTPException(401, "請重新登入 Google 帳戶以存取活動資料")

    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(503, "Google OAuth 未設定")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )

    if resp.status_code != 200:
        request.session.pop("google_access_token", None)
        raise HTTPException(401, "Google 授權已過期，請重新登入")

    data = resp.json()
    access_token = data["access_token"]
    request.session["google_access_token"] = access_token
    expires_in = int(data.get("expires_in", 3600))
    request.session["google_token_expires_at"] = int(datetime.now(timezone.utc).timestamp()) + expires_in
    return access_token


async def get_drive_access_token(request: Request) -> str:
    access_token = request.session.get("google_access_token")
    expires_at = request.session.get("google_token_expires_at", 0)
    now = int(datetime.now(timezone.utc).timestamp())
    if access_token and now < int(expires_at) - 60:
        return access_token
    return await _refresh_access_token(request)


def store_google_tokens(request: Request, token: dict) -> None:
    access_token = token.get("access_token")
    if access_token:
        request.session["google_access_token"] = access_token
    refresh_token = token.get("refresh_token")
    if refresh_token:
        request.session["google_refresh_token"] = refresh_token
    expires_in = int(token.get("expires_in", 3600))
    request.session["google_token_expires_at"] = int(datetime.now(timezone.utc).timestamp()) + expires_in


async def _drive_request(
    method: str,
    url: str,
    token: str,
    *,
    json_body: dict | None = None,
    content: bytes | None = None,
    content_type: str | None = None,
    params: dict | None = None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"}
    if content is not None:
        headers["Content-Type"] = content_type or MIME_TYPE
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.request(
            method,
            url,
            headers=headers,
            json=json_body,
            content=content,
            params=params,
        )


async def _find_events_file(token: str) -> dict | None:
    resp = await _drive_request(
        "GET",
        f"{DRIVE_API}/files",
        token,
        params={
            "spaces": "appDataFolder",
            "q": f"name='{EVENTS_FILENAME}' and trashed=false",
            "fields": "files(id,name,modifiedTime)",
        },
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"無法讀取 Google Drive：{resp.text}")

    files = resp.json().get("files", [])
    return files[0] if files else None


async def _create_events_file(token: str) -> dict:
    metadata = {
        "name": EVENTS_FILENAME,
        "parents": ["appDataFolder"],
        "mimeType": MIME_TYPE,
    }
    payload = _empty_store()
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{DRIVE_UPLOAD}/files?uploadType=multipart",
            headers={"Authorization": f"Bearer {token}"},
            files={
                "metadata": (None, json.dumps(metadata), "application/json"),
                "file": (EVENTS_FILENAME, body, MIME_TYPE),
            },
        )

    if resp.status_code not in (200, 201):
        raise HTTPException(502, f"無法建立 Google Drive 活動檔：{resp.text}")
    return resp.json()


async def _download_store(token: str, file_id: str) -> dict:
    resp = await _drive_request(
        "GET",
        f"{DRIVE_API}/files/{file_id}",
        token,
        params={"alt": "media"},
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"無法下載活動資料：{resp.text}")

    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(502, "Google Drive 活動檔格式錯誤") from exc

    if not isinstance(data, dict) or "events" not in data:
        return _empty_store()
    if not isinstance(data["events"], list):
        data["events"] = []
    return data


async def _upload_store(token: str, file_id: str, store: dict) -> None:
    store["updated_at"] = _now_iso()
    body = json.dumps(store, ensure_ascii=False).encode("utf-8")
    resp = await _drive_request(
        "PATCH",
        f"{DRIVE_UPLOAD}/files/{file_id}",
        token,
        content=body,
        content_type=MIME_TYPE,
        params={"uploadType": "media"},
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"無法儲存活動資料：{resp.text}")


async def _load_store(request: Request) -> tuple[dict, dict]:
    token = await get_drive_access_token(request)
    file_meta = await _find_events_file(token)
    if not file_meta:
        file_meta = await _create_events_file(token)
    store = await _download_store(token, file_meta["id"])
    return store, file_meta


async def _save_store(request: Request, store: dict, file_meta: dict) -> None:
    token = await get_drive_access_token(request)
    await _upload_store(token, file_meta["id"], store)


async def list_events(request: Request) -> list[dict]:
    store, _ = await _load_store(request)
    return [format_event_for_api(event) for event in store.get("events", [])]


async def get_event(request: Request, event_id: str) -> dict | None:
    store, _ = await _load_store(request)
    for event in store.get("events", []):
        if str(event.get("id")) == str(event_id):
            return format_event_for_api(event)
    return None


def _build_event_record(payload: dict, source_filename: str | None = None) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "title": payload.get("title", "未命名活動"),
        "description": payload.get("description"),
        "event_date": payload["event_date"],
        "end_date": payload.get("end_date"),
        "event_time": payload.get("event_time"),
        "location": payload.get("location"),
        "category": payload.get("category", "other"),
        "notes": payload.get("notes"),
        "source_filename": payload.get("source_filename") or source_filename or "手動新增",
        "created_at": _now_iso(),
    }


async def create_event(request: Request, payload: dict) -> str:
    store, file_meta = await _load_store(request)
    event = _build_event_record(payload, payload.get("source_filename"))
    store.setdefault("events", []).append(event)
    await _save_store(request, store, file_meta)
    return event["id"]


async def create_events_bulk(
    request: Request,
    events: list[dict],
    source_filename: str,
) -> list[str]:
    store, file_meta = await _load_store(request)
    ids = []
    for item in events:
        event = _build_event_record(item, item.get("source_filename") or source_filename)
        store.setdefault("events", []).append(event)
        ids.append(event["id"])
    await _save_store(request, store, file_meta)
    return ids


async def update_event(request: Request, event_id: str, payload: dict) -> bool:
    store, file_meta = await _load_store(request)
    updated = False
    for event in store.get("events", []):
        if str(event.get("id")) != str(event_id):
            continue
        for key in (
            "title",
            "description",
            "event_date",
            "end_date",
            "event_time",
            "location",
            "category",
            "notes",
        ):
            if key in payload:
                event[key] = payload[key]
        updated = True
        break
    if not updated:
        return False
    await _save_store(request, store, file_meta)
    return True


async def delete_event(request: Request, event_id: str) -> bool:
    store, file_meta = await _load_store(request)
    events = store.get("events", [])
    new_events = [e for e in events if str(e.get("id")) != str(event_id)]
    if len(new_events) == len(events):
        return False
    store["events"] = new_events
    await _save_store(request, store, file_meta)
    return True


async def delete_events_bulk(request: Request, event_ids: list[str]) -> int:
    if not event_ids:
        return 0
    wanted = {str(i) for i in event_ids}
    store, file_meta = await _load_store(request)
    events = store.get("events", [])
    new_events = [e for e in events if str(e.get("id")) not in wanted]
    deleted = len(events) - len(new_events)
    if deleted:
        store["events"] = new_events
        await _save_store(request, store, file_meta)
    return deleted