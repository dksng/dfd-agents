from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict
from typing import Any

from fastapi import WebSocket


class EventHub:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._global: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, run_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[run_id].add(websocket)

    async def disconnect(self, run_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[run_id].discard(websocket)
            if not self._connections[run_id]:
                self._connections.pop(run_id, None)

    async def connect_global(self, websocket: WebSocket) -> None:
        """Subscribe to all run events regardless of which workflow/run is open."""
        await websocket.accept()
        async with self._lock:
            self._global.add(websocket)

    async def disconnect_global(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._global.discard(websocket)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._connections.get(run_id, set())) + list(self._global)
        for websocket in targets:
            try:
                await websocket.send_json(event)
            except RuntimeError:
                await self.disconnect(run_id, websocket)
                await self.disconnect_global(websocket)

    async def publish_graph(
        self,
        workflow_id: str,
        action: str,
        payload: dict[str, Any] | None = None,
        origin: str = "",
    ) -> None:
        """Broadcast a graph (structure/config) change so other clients — the human
        GUI or an AI agent — can live-refresh the affected workflow. Not tied to a run.
        ``origin`` carries the id of the client that made the change so it can ignore
        its own echo. Best-effort: a delivery failure must never break the API call."""
        with contextlib.suppress(Exception):  # graph sync is advisory only
            await self.publish(
                "",
                {
                    "type": "graph",
                    "action": action,
                    "workflow_id": workflow_id,
                    "run_id": "",
                    "process_id": "",
                    "origin": origin,
                    "payload": payload or {},
                },
            )
