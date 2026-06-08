from __future__ import annotations

import json
from typing import Any


def parse_event(line: str) -> dict[str, Any]:
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return {"message": line, "raw": {"line": line}}
    message = data.get("message")
    message_id = None
    if isinstance(message, dict):
        message_id = message.get("id")
        text_blocks = message.get("content") or []
        if isinstance(text_blocks, list):
            text = " ".join(block.get("text", "") for block in text_blocks if isinstance(block, dict))
            message = text or data.get("type")
    usage = data.get("usage")
    if not usage and isinstance(data.get("message"), dict):
        usage = data["message"].get("usage")
    return {
        "event_type": data.get("type"),
        "message": str(message or data.get("type") or data),
        "message_id": message_id,
        "usage": usage,
        "total_cost_usd": data.get("total_cost_usd"),
        "session_id": data.get("session_id") or data.get("sessionId"),
        "raw": data,
    }


def normalize_usage(usage: dict[str, Any]) -> dict[str, int]:
    cache_creation = usage.get("cache_creation")
    if not isinstance(cache_creation, dict):
        cache_creation = {}
    cache_write_5m = int(usage.get("cache_write_5m", cache_creation.get("ephemeral_5m_input_tokens", 0)) or 0)
    cache_write_1h = int(usage.get("cache_write_1h", cache_creation.get("ephemeral_1h_input_tokens", 0)) or 0)
    cache_write = int(usage.get("cache_creation_input_tokens", usage.get("cache_write", 0)) or 0)
    if cache_write == 0:
        cache_write = cache_write_5m + cache_write_1h
    return {
        "input_tokens": int(usage.get("input_tokens", 0)),
        "output_tokens": int(usage.get("output_tokens", 0)),
        "cache_read": int(usage.get("cache_read_input_tokens", usage.get("cache_read", 0))),
        "cache_write": cache_write,
        "cache_write_5m": cache_write_5m,
        "cache_write_1h": cache_write_1h,
    }


def usage_for_event(parsed: dict[str, Any], seen_message_ids: set[str]) -> dict[str, int] | None:
    if parsed.get("event_type") != "assistant" or not parsed.get("usage"):
        return None
    message_id = parsed.get("message_id")
    if not message_id:
        return normalize_usage(parsed["usage"])
    if message_id in seen_message_ids:
        return None
    seen_message_ids.add(message_id)
    usage = normalize_usage(parsed["usage"])
    return usage if any(usage.values()) else None


def final_cost_for_event(parsed: dict[str, Any]) -> float | None:
    if parsed.get("event_type") != "result" or parsed.get("total_cost_usd") is None:
        return None
    return float(parsed["total_cost_usd"])
