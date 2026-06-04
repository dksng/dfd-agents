from __future__ import annotations

from .base import AgentAdapter, AgentResult
from .claude import ClaudeCodeAdapter
from .mock import MockAgentAdapter

__all__ = ["AgentAdapter", "AgentResult", "ClaudeCodeAdapter", "MockAgentAdapter"]
