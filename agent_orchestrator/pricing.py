from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEFAULT_PRICING = {
    "currency": "USD",
    "models": {
        "claude-sonnet-4-5": {
            "input": 3.0,
            "output": 15.0,
            "cache_read": 0.3,
            "cache_write": 3.75,
        },
        "claude-opus-4-8": {
            "input": 15.0,
            "output": 75.0,
            "cache_read": 1.5,
            "cache_write": 18.75,
        },
    },
}


class Pricing:
    def __init__(self, path: Path):
        self.path = path
        self.table = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(yaml.safe_dump(DEFAULT_PRICING, sort_keys=True), encoding="utf-8")
            return DEFAULT_PRICING
        data = yaml.safe_load(self.path.read_text(encoding="utf-8")) or {}
        if "models" not in data:
            data["models"] = {}
        return data

    def cost(
        self,
        model: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read: int = 0,
        cache_write: int = 0,
    ) -> float:
        rates = self.table.get("models", {}).get(model)
        if not rates:
            return 0.0
        return (
            input_tokens * float(rates.get("input", 0))
            + output_tokens * float(rates.get("output", 0))
            + cache_read * float(rates.get("cache_read", 0))
            + cache_write * float(rates.get("cache_write", 0))
        ) / 1_000_000
