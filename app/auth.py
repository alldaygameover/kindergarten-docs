import os
from datetime import datetime, timezone

from authlib.integrations.starlette_client import OAuth
from fastapi import HTTPException, Request

from app.database import get_user_by_id, upsert_user

oauth = OAuth()


def init_oauth() -> None:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        return

    oauth.register(
        name="google",
        client_id=client_id,
        client_secret=client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def oauth_configured() -> bool:
    return bool(os.getenv("GOOGLE_CLIENT_ID") and os.getenv("GOOGLE_CLIENT_SECRET"))


async def get_current_user(request: Request) -> dict:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="請先登入 Google 帳戶")

    user = await get_user_by_id(user_id)
    if not user:
        request.session.clear()
        raise HTTPException(status_code=401, detail="請先登入 Google 帳戶")
    return user


async def login_with_google(request: Request, token: dict) -> dict:
    user_info = token.get("userinfo")
    if not user_info:
        raise HTTPException(400, "無法取得 Google 帳戶資料")

    user = await upsert_user(
        google_id=user_info["sub"],
        email=user_info.get("email", ""),
        name=user_info.get("name", ""),
        picture=user_info.get("picture", ""),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    request.session["user_id"] = user["id"]
    return user