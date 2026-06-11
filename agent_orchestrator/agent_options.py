from __future__ import annotations

AGENT_KIND_VALUES = {"claude", "copilot"}
AGENT_EFFORT_VALUES = {"low", "medium", "high", "xhigh", "max"}

# Empty string inherits the global default.
PERMISSION_MODE_VALUES = {"", "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"}
