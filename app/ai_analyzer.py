import asyncio
import json
import os
import re

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_INPUT_CHARS = 6000
MAX_SUMMARY_CHARS = 200
MAX_EVENTS = 25

DEFAULT_VISION_MODELS = [
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "nex-agi/nex-n2-pro:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free",
]

DEFAULT_TEXT_MODELS = [
    "openai/gpt-oss-20b:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "openai/gpt-oss-120b:free",
]

SYSTEM_PROMPT = """你是香港幼稚園文件分析助手。從通告中提取活動和日期。

重要規則：
- 只回覆一個 JSON 物件，不要 markdown，不要解釋
- summary 最多 2 句繁體中文（香港用語），不可重複
- 只提取有明確日期的活動/事項，最多 25 個
- 合併相同活動，不要重複列出
- 日期格式 YYYY-MM-DD
- category 必須是：holiday, activity, payment, uniform, meeting, excursion, other 之一

JSON 格式：
{"summary":"簡短摘要","events":[{"title":"名稱","description":"說明或null","event_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD或null","event_time":"時間或null","location":"地點或null","category":"activity","notes":"注意事項或null"}]}
"""

COMPACT_RETRY_PROMPT = """只回覆精簡 JSON。summary 不超過 40 字。只列出最重要、有明確日期的活動（最多 15 個）。不可重複內容。
{"summary":"...","events":[{"title":"...","event_date":"YYYY-MM-DD","category":"activity"}]}
"""


class RateLimitError(Exception):
    pass


class JsonParseError(Exception):
    pass


def _get_headers() -> dict:
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        raise ValueError("請設定 OPENROUTER_API_KEY（到 openrouter.ai 免費申請）")
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": os.getenv("APP_URL", "http://localhost:8765"),
        "X-Title": "Kindergarten Docs Calendar",
    }


def _get_model_list(env_key: str, defaults: list[str]) -> list[str]:
    custom = os.getenv(env_key, "").strip()
    if not custom:
        return defaults
    models = [m.strip() for m in custom.split(",") if m.strip()]
    return models or defaults


def _truncate_text(text: str) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) <= MAX_INPUT_CHARS:
        return text
    return (
        text[:MAX_INPUT_CHARS]
        + "\n\n[文件內容已截斷，請專注分析以上部分的重要日期和活動]"
    )


def _clean_json_text(content: str) -> str:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    return content.strip()


def _close_truncated_json(text: str) -> str:
    text = text.rstrip()
    if text.endswith("}"):
        return text

    if '"events"' not in text:
        if text.endswith('"'):
            return text + ', "events": []}'
        return text + '", "events": []}'

    if text.endswith("]"):
        return text + "}"
    if text.endswith("}"):
        return text + "]}"
    if text.endswith(","):
        return text.rstrip(",") + "]}"
    return text + '"}]}'


def _salvage_partial_json(content: str) -> dict | None:
    summary_match = re.search(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)', content)
    summary = ""
    if summary_match:
        summary = summary_match.group(1).replace('\\"', '"').replace("\\n", " ")
        summary = re.sub(r"\s+", " ", summary).strip()[:MAX_SUMMARY_CHARS]

    events = []
    for block in re.finditer(r"\{[^{}]*?\"title\"[^{}]*?\}", content):
        try:
            event = json.loads(block.group())
            if event.get("title") and event.get("event_date"):
                events.append(event)
        except json.JSONDecodeError:
            continue

    if summary or events:
        return {"summary": summary or "文件已分析", "events": events}
    return None


def _normalize_result(data: dict) -> dict:
    summary = str(data.get("summary", "")).strip()
    summary = re.sub(r"\s+", " ", summary)[:MAX_SUMMARY_CHARS]

    events = data.get("events", [])
    if not isinstance(events, list):
        events = []

    seen = set()
    normalized = []
    for event in events[:MAX_EVENTS]:
        if not isinstance(event, dict):
            continue
        title = str(event.get("title", "")).strip()
        event_date = str(event.get("event_date", "")).strip()
        if not title or not event_date or event_date == "null":
            continue
        key = (title, event_date)
        if key in seen:
            continue
        seen.add(key)
        normalized.append({
            "title": title,
            "description": event.get("description"),
            "event_date": event_date,
            "end_date": event.get("end_date"),
            "event_time": event.get("event_time"),
            "location": event.get("location"),
            "category": event.get("category") or "other",
            "notes": event.get("notes"),
        })

    return {"summary": summary or "文件已分析", "events": normalized}


def _parse_json_response(content: str) -> dict:
    content = _clean_json_text(content)
    attempts = [content, _close_truncated_json(content)]

    for candidate in attempts:
        try:
            return _normalize_result(json.loads(candidate))
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*", candidate)
            if match:
                try:
                    return _normalize_result(json.loads(_close_truncated_json(match.group())))
                except json.JSONDecodeError:
                    pass

    salvaged = _salvage_partial_json(content)
    if salvaged:
        return _normalize_result(salvaged)

    raise JsonParseError(f"AI 回覆無法解析為 JSON: {content[:200]}")


def _is_rate_limited(status_code: int, body: str) -> bool:
    if status_code == 429:
        return True
    return "rate-limit" in body.lower() or "rate limited" in body.lower()


async def _call_openrouter(messages: list, model: str) -> str:
    last_error = ""
    for attempt in range(3):
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                OPENROUTER_URL,
                headers=_get_headers(),
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": 0.1,
                    "max_tokens": 2048,
                },
            )

        body = response.text
        if _is_rate_limited(response.status_code, body):
            last_error = f"{model} 暫時繁忙"
            if attempt < 2:
                await asyncio.sleep(2 ** attempt + 1)
                continue
            raise RateLimitError(last_error)

        if response.status_code != 200:
            raise ValueError(f"OpenRouter API 錯誤 ({response.status_code}): {body[:300]}")

        data = response.json()
        return data["choices"][0]["message"]["content"]

    raise RateLimitError(last_error or f"{model} 暫時繁忙")


async def _call_with_fallback(messages: list, models: list[str]) -> str:
    errors: list[str] = []
    for model in models:
        try:
            return await _call_openrouter(messages, model)
        except RateLimitError:
            errors.append(f"{model} 被限流")
            continue
    raise ValueError(
        "所有免費 AI 模型暫時繁忙，請等 1-2 分鐘後再試。"
        + (f" ({'; '.join(errors)})" if errors else "")
    )


async def _analyze_messages(messages: list, models: list[str], retry_text: str = "") -> dict:
    raw = await _call_with_fallback(messages, models)
    try:
        return _parse_json_response(raw)
    except JsonParseError:
        if not retry_text:
            raise

    retry_messages = [
        {"role": "system", "content": COMPACT_RETRY_PROMPT},
        {"role": "user", "content": retry_text},
    ]
    raw = await _call_with_fallback(retry_messages, models)
    return _parse_json_response(raw)


async def analyze_with_vision(images: list[dict], text_hint: str = "") -> dict:
    models = _get_model_list("OPENROUTER_VISION_MODELS", DEFAULT_VISION_MODELS)
    text_hint = _truncate_text(text_hint) if text_hint else ""

    content_parts = [{
        "type": "text",
        "text": (
            f"以下是文件文字（可能不完整）：\n{text_hint}\n\n請分析圖片，提取有日期的活動。"
            if text_hint
            else "請分析圖片，提取有日期的活動和事項。"
        ),
    }]

    for img in images[:2]:
        content_parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:{img['mime']};base64,{img['data']}"},
        })

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content_parts},
    ]

    return await _analyze_messages(messages, models, retry_text=text_hint or "請從圖片提取活動日期")


async def analyze_with_text(text: str) -> dict:
    models = _get_model_list("OPENROUTER_TEXT_MODELS", DEFAULT_TEXT_MODELS)
    text = _truncate_text(text)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"請分析以下幼稚園文件，提取有明確日期的活動：\n\n{text}"},
    ]

    return await _analyze_messages(messages, models, retry_text=text)


async def analyze_document(content: dict) -> dict:
    text = content.get("text", "").strip()
    images = content.get("images", [])

    if text and len(text) >= 30:
        try:
            return await analyze_with_text(text)
        except (RateLimitError, ValueError, JsonParseError) as exc:
            if not images:
                raise
            if not any(k in str(exc) for k in ("繁忙", "限流", "429", "JSON")):
                raise

    if images:
        return await analyze_with_vision(images, text_hint=text)

    if text:
        return await analyze_with_text(text)

    raise ValueError("無法從文件中提取足夠內容進行分析")