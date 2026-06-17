---
title: Kindergarten Docs Calendar
emoji: 📅
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# 幼稚園文件月曆

Upload kindergarten notices (PDF, DOCX, images) — AI extracts dates and shows them on a calendar.

## Setup secrets (Space Settings → Variables and secrets)

| Name | Description |
|------|-------------|
| `OPENROUTER_API_KEY` | API key from [openrouter.ai](https://openrouter.ai) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `APP_URL` | `https://alldaygameover-kg-calendar.hf.space` |
| `SESSION_SECRET` | Random secret string |
| `STORAGE_MODE` | `google_drive` (recommended — events stored in user's Google account) |

## Google Cloud setup

1. Enable **Google Drive API** in the same project as your OAuth credentials
2. OAuth consent screen — add scope: `https://www.googleapis.com/auth/drive.appdata`
3. Add redirect URI in Google Cloud Console:

```
https://alldaygameover-kg-calendar.hf.space/auth/callback
```

4. After deploy, users must **log in again** to grant Drive access

### Storage modes

| Mode | Files | Events |
|------|-------|--------|
| `google_drive` (default) | Phone (IndexedDB) | Google Drive hidden app data |
| `hybrid` | Phone | HF server SQLite (legacy) |
| `local` | Phone | Phone |
| `server` | HF server | HF server |