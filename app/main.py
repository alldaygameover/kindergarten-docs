import os
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.ai_analyzer import analyze_document
from app.auth import get_current_user, init_oauth, login_with_google, oauth, oauth_configured
from app.database import (
    create_events_bulk,
    create_manual_event,
    delete_document,
    delete_event,
    delete_events_by_ids,
    get_document_by_id,
    get_documents_for_user,
    get_event_by_id,
    get_events_for_user,
    init_db,
    save_document,
    save_events,
    update_event,
)
from app.extractors import extract_content, get_file_type

load_dotenv()

BASE_DIR = Path(__file__).parent.parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

app = FastAPI(title="幼稚園文件月曆")
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET", secrets.token_hex(32)),
    same_site="lax",
    https_only=os.getenv("APP_URL", "").startswith("https://"),
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

init_oauth()


def get_redirect_uri(request: Request) -> str:
    return os.getenv("APP_URL", str(request.base_url).rstrip("/")) + "/auth/callback"


def user_upload_dir(user_id: int) -> Path:
    path = BASE_DIR / "uploads" / str(user_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
}


def parse_date_only(value) -> str | None:
    if not value or str(value).strip() in ("", "null"):
        return None
    match = re.match(r"(\d{4}-\d{2}-\d{2})", str(value).strip())
    return match.group(1) if match else None


def parse_time_only(value) -> str | None:
    if not value or str(value).strip() in ("", "null"):
        return None
    match = re.search(r"(\d{1,2}):(\d{2})", str(value).strip())
    if not match:
        return None
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def build_calendar_event(e: dict) -> dict | None:
    event_date = parse_date_only(e.get("event_date"))
    if not event_date:
        return None

    end_date = parse_date_only(e.get("end_date")) or event_date
    parsed_time = parse_time_only(e.get("event_time"))
    display_time = e.get("event_time") if e.get("event_time") not in (None, "", "null") else None

    color = {
        "holiday": "#e74c3c",
        "activity": "#3498db",
        "payment": "#f39c12",
        "uniform": "#9b59b6",
        "meeting": "#1abc9c",
        "excursion": "#27ae60",
        "other": "#95a5a6",
    }.get(e.get("category"), "#95a5a6")

    if parsed_time:
        start_dt = datetime.fromisoformat(f"{event_date}T{parsed_time}:00")
        end_dt = start_dt + timedelta(hours=1)
        start = start_dt.isoformat(timespec="seconds")
        end = end_dt.isoformat(timespec="seconds")
        all_day = False
    else:
        start = event_date
        end = (date.fromisoformat(end_date) + timedelta(days=1)).isoformat()
        all_day = True

    return {
        "id": e["id"],
        "title": e["title"],
        "start": start,
        "end": end,
        "allDay": all_day,
        "backgroundColor": color,
        "borderColor": color,
        "extendedProps": {
            "description": e.get("description"),
            "time": display_time,
            "location": e.get("location"),
            "category": e.get("category"),
            "notes": e.get("notes"),
            "filename": e.get("filename"),
        },
    }


def resolve_document_file(doc: dict, user_id: int) -> Path | None:
    stored_path = doc.get("stored_path")
    if stored_path:
        path = BASE_DIR / stored_path
        if path.is_file():
            return path

    upload_dir = user_upload_dir(user_id)
    matches = sorted(upload_dir.glob(f"*_{doc['filename']}"), reverse=True)
    for candidate in matches:
        if candidate.is_file():
            return candidate
    return None


@app.on_event("startup")
async def startup():
    await init_db()


@app.get("/", response_class=HTMLResponse)
async def index():
    return (TEMPLATES_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/me")
async def api_me(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        return {"authenticated": False}
    from app.database import get_user_by_id

    user = await get_user_by_id(user_id)
    if not user:
        request.session.clear()
        return {"authenticated": False}
    return {
        "authenticated": True,
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "picture": user["picture"],
    }


@app.get("/auth/login")
async def auth_login(request: Request):
    if not oauth_configured():
        raise HTTPException(
            503,
            "請設定 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。"
            "到 Google Cloud Console 建立 OAuth 憑證。",
        )
    redirect_uri = get_redirect_uri(request)
    return await oauth.google.authorize_redirect(request, redirect_uri)


@app.get("/auth/callback")
async def auth_callback(request: Request):
    try:
        token = await oauth.google.authorize_access_token(request)
        await login_with_google(request, token)
    except Exception as exc:
        raise HTTPException(400, f"Google 登入失敗: {exc}") from exc
    return RedirectResponse("/")


@app.get("/auth/logout")
async def auth_logout(request: Request):
    request.session.clear()
    return RedirectResponse("/")


def normalize_event_payload(event: dict) -> dict | None:
    event_date = parse_date_only(event.get("event_date"))
    if not event_date:
        return None
    end_date = parse_date_only(event.get("end_date"))
    parsed_time = parse_time_only(event.get("event_time"))
    raw_time = event.get("event_time")
    display_time = None
    if raw_time and str(raw_time).strip() not in ("", "null"):
        display_time = parsed_time or str(raw_time).strip()
    return {
        "title": event.get("title", "未命名活動"),
        "description": event.get("description"),
        "event_date": event_date,
        "end_date": end_date if end_date and end_date != event_date else None,
        "event_time": display_time,
        "location": event.get("location"),
        "category": event.get("category", "other"),
        "notes": event.get("notes"),
        "source_filename": event.get("source_filename"),
    }


@app.get("/api/events/list")
async def api_events_list(user: dict = Depends(get_current_user)):
    return await get_events_for_user(user["id"])


@app.get("/api/events")
async def api_events(user: dict = Depends(get_current_user)):
    events = await get_events_for_user(user["id"])
    calendar_events = []
    for e in events:
        calendar_event = build_calendar_event(e)
        if calendar_event:
            calendar_events.append(calendar_event)
    return calendar_events


@app.get("/api/documents")
async def api_documents(user: dict = Depends(get_current_user)):
    return await get_documents_for_user(user["id"])


@app.get("/api/events/{event_id}")
async def api_get_event(event_id: int, user: dict = Depends(get_current_user)):
    event = await get_event_by_id(event_id, user["id"])
    if not event:
        raise HTTPException(404, "找不到該活動")
    return event


@app.post("/api/events/bulk")
async def api_create_events_bulk(
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    raw_events = payload.get("events") or []
    if not isinstance(raw_events, list) or not raw_events:
        raise HTTPException(400, "請提供活動列表")

    source_filename = payload.get("source_filename") or "手動新增"
    normalized = []
    for event in raw_events:
        item = normalize_event_payload(event)
        if item:
            normalized.append(item)

    if not normalized:
        raise HTTPException(400, "沒有有效的活動日期")

    ids = await create_events_bulk(
        user["id"],
        normalized,
        source_filename,
        datetime.now(timezone.utc).isoformat(),
    )
    return {"ids": ids, "count": len(ids), "ok": True}


@app.delete("/api/events/bulk")
async def api_delete_events_bulk(
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    event_ids = payload.get("ids") or []
    if not isinstance(event_ids, list):
        raise HTTPException(400, "請提供活動 ID 列表")
    deleted = await delete_events_by_ids(user["id"], [int(i) for i in event_ids])
    return {"deleted": deleted, "ok": True}


@app.post("/api/events")
async def api_create_event(
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    if not payload.get("title") or not payload.get("event_date"):
        raise HTTPException(400, "請提供標題和日期")

    end_date = payload.get("end_date")
    if end_date and end_date < payload["event_date"]:
        raise HTTPException(400, "結束日期不能早於開始日期")

    event_id = await create_manual_event(
        user["id"],
        payload,
        datetime.now(timezone.utc).isoformat(),
    )
    return {"id": event_id, "ok": True}


@app.put("/api/events/{event_id}")
async def api_update_event(
    event_id: int,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    end_date = payload.get("end_date")
    event_date = payload.get("event_date")
    if end_date and event_date and end_date < event_date:
        raise HTTPException(400, "結束日期不能早於開始日期")

    updated = await update_event(event_id, user["id"], payload)
    if not updated:
        raise HTTPException(404, "找不到該活動")
    return {"ok": True}


@app.delete("/api/events/{event_id}")
async def api_delete_event(event_id: int, user: dict = Depends(get_current_user)):
    deleted = await delete_event(event_id, user["id"])
    if not deleted:
        raise HTTPException(404, "找不到該活動")
    return {"ok": True}


@app.get("/api/documents/{document_id}/file")
async def api_document_file(
    document_id: int,
    download: bool = False,
    user: dict = Depends(get_current_user),
):
    doc = await get_document_by_id(document_id, user["id"])
    if not doc:
        raise HTTPException(404, "找不到該文件")

    file_path = resolve_document_file(doc, user["id"])
    if not file_path:
        raise HTTPException(404, "找不到原始檔案，可能已於較早版本上傳")

    ext = Path(doc["filename"]).suffix.lower()
    media_type = CONTENT_TYPES.get(ext, "application/octet-stream")
    viewable = ext in {".pdf", ".jpg", ".jpeg", ".png", ".webp"}
    disposition = "attachment" if download or not viewable else "inline"

    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=doc["filename"],
        content_disposition_type=disposition,
    )


@app.delete("/api/documents/{document_id}")
async def api_delete_document(document_id: int, user: dict = Depends(get_current_user)):
    doc = await delete_document(document_id, user["id"])
    if not doc:
        raise HTTPException(404, "找不到該文件")

    upload_dir = user_upload_dir(user["id"])
    stored_path = doc.get("stored_path")
    if stored_path:
        file_path = BASE_DIR / stored_path
        if file_path.is_file():
            file_path.unlink()
    else:
        for candidate in upload_dir.glob(f"*_{doc['filename']}"):
            candidate.unlink(missing_ok=True)

    return {"ok": True}


@app.post("/api/analyze")
async def api_analyze(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Analyze a file in memory only — nothing is saved to disk."""
    del user  # auth gate only
    if not os.getenv("OPENROUTER_API_KEY"):
        raise HTTPException(
            400,
            "請先設定 OPENROUTER_API_KEY。到 https://openrouter.ai 免費申請 API key，"
            "然後在 .env 檔案填入。",
        )

    if not file.filename:
        raise HTTPException(400, "缺少檔案")

    file_type = get_file_type(file.filename)
    if file_type == "unknown":
        raise HTTPException(400, "不支援的檔案格式")

    try:
        data = await file.read()
        content = extract_content(file.filename, data)
        analysis = await analyze_document(content)
        events = analysis.get("events", [])
        valid_events = [e for e in events if e.get("event_date")]

        return {
            "filename": file.filename,
            "file_type": file_type,
            "summary": analysis.get("summary", ""),
            "events": valid_events,
            "events_found": len(valid_events),
        }
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/upload")
async def api_upload(
    files: list[UploadFile] = File(...),
    user: dict = Depends(get_current_user),
):
    if not os.getenv("OPENROUTER_API_KEY"):
        raise HTTPException(
            400,
            "請先設定 OPENROUTER_API_KEY。到 https://openrouter.ai 免費申請 API key，"
            "然後在 .env 檔案填入。",
        )

    results = []
    now = datetime.now(timezone.utc).isoformat()
    upload_dir = user_upload_dir(user["id"])

    for file in files:
        if not file.filename:
            continue

        file_type = get_file_type(file.filename)
        if file_type == "unknown":
            results.append({
                "filename": file.filename,
                "success": False,
                "error": "不支援的檔案格式",
            })
            continue

        try:
            data = await file.read()
            safe_name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file.filename}"
            stored_path = Path("uploads") / str(user["id"]) / safe_name
            (upload_dir / safe_name).write_bytes(data)

            content = extract_content(file.filename, data)
            analysis = await analyze_document(content)

            doc_id = await save_document(
                user_id=user["id"],
                filename=file.filename,
                file_type=file_type,
                uploaded_at=now,
                raw_text=content.get("text", ""),
                summary=analysis.get("summary", ""),
                stored_path=str(stored_path).replace("\\", "/"),
            )

            events = analysis.get("events", [])
            valid_events = [e for e in events if e.get("event_date")]
            saved = await save_events(doc_id, valid_events, now)

            results.append({
                "filename": file.filename,
                "success": True,
                "summary": analysis.get("summary", ""),
                "events_found": len(valid_events),
                "events_saved": saved,
            })
        except Exception as exc:
            results.append({
                "filename": file.filename,
                "success": False,
                "error": str(exc),
            })

    return {"results": results}


@app.get("/api/health")
async def health(request: Request):
    mode = os.getenv("STORAGE_MODE", "hybrid")
    files_storage = "local" if mode in ("local", "hybrid") else "server"
    events_storage = "server" if mode in ("server", "hybrid") else "local"
    return {
        "status": "ok",
        "api_key_set": bool(os.getenv("OPENROUTER_API_KEY")),
        "google_oauth_set": oauth_configured(),
        "vision_models": os.getenv(
            "OPENROUTER_VISION_MODELS",
            "nvidia/nemotron-nano-12b-v2-vl:free,nex-agi/nex-n2-pro:free",
        ).split(",")[0],
        "redirect_uri": get_redirect_uri(request),
        "storage_mode": mode,
        "files_storage": files_storage,
        "events_storage": events_storage,
    }