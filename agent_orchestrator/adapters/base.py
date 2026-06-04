from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agent_orchestrator.execution import ExecutionEngine


@dataclass
class AgentResult:
    ok: bool
    submitted: bool = False
    session_id: str | None = None
    error: str | None = None


class AgentAdapter:
    async def run(
        self,
        engine: ExecutionEngine,
        run: dict[str, Any],
        process: dict[str, Any],
        *,
        resume: bool,
        feedback_text: str,
    ) -> AgentResult:
        raise NotImplementedError
