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
| `APP_URL` | `https://alldaygameover-kindergarten-docs.hf.space` |
| `SESSION_SECRET` | Random secret string |

## Google OAuth

Add this redirect URI in Google Cloud Console:

```
https://alldaygameover-kindergarten-docs.hf.space/auth/callback
```