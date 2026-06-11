from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

DEFAULT_PRICING = {
    "cost_source": "pricing",
    "currency": "USD",
    "default_model": "claude-sonnet-4-6",
    "models": {
        "claude-opus-4-8": {
            "enabled": True,
            "label": "Claude Opus 4.8",
            "input": 5.0,
            "output": 25.0,
            "cache_read": 0.5,
            "cache_write_5m": 6.25,
            "cache_write_1h": 10.0,
        },
        "claude-opus-4-7": {
            "enabled": True,
            "label": "Claude Opus 4.7",
            "input": 5.0,
            "output": 25.0,
            "cache_read": 0.5,
            "cache_write_5m": 6.25,
            "cache_write_1h": 10.0,
        },
        "claude-opus-4-6": {
            "enabled": True,
            "label": "Claude Opus 4.6",
            "input": 5.0,
            "output": 25.0,
            "cache_read": 0.5,
            "cache_write_5m": 6.25,
            "cache_write_1h": 10.0,
        },
        "claude-opus-4-5": {
            "enabled": True,
            "label": "Claude Opus 4.5",
            "input": 5.0,
            "output": 25.0,
            "cache_read": 0.5,
            "cache_write_5m": 6.25,
            "cache_write_1h": 10.0,
        },
        "claude-opus-4-1": {
            "enabled": False,
            "label": "Claude Opus 4.1 (deprecated)",
            "input": 15.0,
            "output": 75.0,
            "cache_read": 1.5,
            "cache_write_5m": 18.75,
            "cache_write_1h": 30.0,
        },
        "claude-opus-4": {
            "enabled": False,
            "label": "Claude Opus 4 (deprecated)",
            "input": 15.0,
            "output": 75.0,
            "cache_read": 1.5,
            "cache_write_5m": 18.75,
            "cache_write_1h": 30.0,
        },
        "claude-sonnet-4-6": {
            "enabled": True,
            "label": "Claude Sonnet 4.6",
            "input": 3.0,
            "output": 15.0,
            "cache_read": 0.3,
            "cache_write_5m": 3.75,
            "cache_write_1h": 6.0,
        },
        "claude-haiku-4-5": {
            "enabled": True,
            "label": "Claude Haiku 4.5",
            "input": 1.0,
            "output": 5.0,
            "cache_read": 0.1,
            "cache_write_5m": 1.25,
            "cache_write_1h": 2.0,
        },
    },
}


class Pricing:
    def __init__(self, path: Path):
        self.path = path
        self.table = self._load()
        self._warned_models: set[str] = set()

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
                    "cache_write_5m": float(rates.get("cache_write_5m", rates.get("cache_write", 0))),
                    "cache_write_1h": float(rates.get("cache_write_1h", rates.get("cache_write", 0))),
                }
            )
        ids = {model["id"] for model in models}
        configured_default = str(self.table.get("default_model") or "")
        if configured_default in ids:
            default_model = configured_default
        elif "claude-sonnet-4-6" in ids:
            default_model = "claude-sonnet-4-6"
        else:
            default_model = models[0]["id"] if models else "claude-sonnet-4-6"
        return {
            "currency": str(self.table.get("currency") or "USD"),
            "default_model": default_model,
            "models": models,
        }

    def default_model(self) -> str:
        return str(self.model_catalog()["default_model"])

    def use_result_total_cost(self) -> bool:
        return str(self.table.get("cost_source") or "pricing") == "result_total_cost"

    def cost(
        self,
        model: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read: int = 0,
        cache_write: int = 0,
        cache_write_5m: int = 0,
        cache_write_1h: int = 0,
    ) -> float:
        rates = self.table.get("models", {}).get(model)
        if not rates:
            if model not in self._warned_models:
                self._warned_models.add(model)
                logger.warning("No pricing entry for model %r; recording cost as 0. Add it to %s", model, self.path)
            return 0.0
        legacy_cache_write_rate = float(rates.get("cache_write", rates.get("cache_write_5m", 0)))
        if cache_write_5m or cache_write_1h:
            cache_write_cost = cache_write_5m * float(rates.get("cache_write_5m", legacy_cache_write_rate))
            cache_write_cost += cache_write_1h * float(rates.get("cache_write_1h", legacy_cache_write_rate))
        else:
            cache_write_cost = cache_write * legacy_cache_write_rate
        return (
            input_tokens * float(rates.get("input", 0))
            + output_tokens * float(rates.get("output", 0))
            + cache_read * float(rates.get("cache_read", 0))
            + cache_write_cost
        ) / 1_000_000
