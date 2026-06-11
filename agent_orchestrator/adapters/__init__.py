from __future__ import annotations

from .base import AgentAdapter, AgentResult
from .claude import ClaudeCodeAdapter
from .copilot import CopilotCliAdapter
from .mock import MockAgentAdapter

__all__ = ["AgentAdapter", "AgentResult", "ClaudeCodeAdapter", "CopilotCliAdapter", "MockAgentAdapter"]
