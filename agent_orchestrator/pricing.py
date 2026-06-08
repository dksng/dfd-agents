from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEFAULT_PRICING = {
    "currency": "USD",
    "default_model": "claude-sonnet-4-5",
    "models": {
        "claude-sonnet-4-5": {
            "enabled": True,
            "label": "Claude Sonnet 4.5",
            "input": 3.0,
            "output": 15.0,
            "cache_read": 0.3,
            "cache_write": 3.75,
        },
        "claude-opus-4-8": {
            "enabled": True,
            "label": "Claude Opus 4.8",
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

    def model_catalog(self) -> dict[str, Any]:
        models = []
        for model_id, rates in self.table.get("models", {}).items():
            if not isinstance(rates, dict) or not rates.get("enabled", True):
                continue
            models.append(
                {
                    "id": model_id,
                    "label": str(rates.get("label") or model_id),
                    "input": float(rates.get("input", 0)),
                    "output": float(rates.get("output", 0)),
                    "cache_read": float(rates.get("cache_read", 0)),
                    "cache_write": float(rates.get("cache_write", 0)),
                }
            )
        ids = {model["id"] for model in models}
        configured_default = str(self.table.get("default_model") or "")
        if configured_default in ids:
            default_model = configured_default
        elif "claude-sonnet-4-5" in ids:
            default_model = "claude-sonnet-4-5"
        else:
            default_model = models[0]["id"] if models else "claude-sonnet-4-5"
        return {
            "currency": str(self.table.get("currency") or "USD"),
            "default_model": default_model,
            "models": models,
        }

    def default_model(self) -> str:
        return str(self.model_catalog()["default_model"])

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
