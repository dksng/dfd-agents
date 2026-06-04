from __future__ import annotations

from typing import Any

from .agent_options import AGENT_EFFORT_VALUES, PERMISSION_MODE_VALUES
from .config import Settings
from .exceptions import AppValidationError


def split_tools(value: str) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def permission_setting(process: dict[str, Any], key: str, default: str) -> str:
    value = (process.get(key) or "").strip()
    if value:
        return value
    return default


def apply_permissions(command: list[str], process: dict[str, Any], settings: Settings | None = None) -> None:
    default_mode = settings.default_permission_mode if settings else "default"
    default_allowed = settings.default_allowed_tools if settings else ""
    default_disallowed = settings.default_disallowed_tools if settings else ""

    mode = permission_setting(process, "permission_mode", default_mode)
    if mode and "--permission-mode" not in command:
        if mode not in PERMISSION_MODE_VALUES or mode == "":
            raise AppValidationError(f"Invalid permission_mode: {mode}")
        command.extend(["--permission-mode", mode])

    allowed = split_tools(permission_setting(process, "allowed_tools", default_allowed))
    disallowed = split_tools(permission_setting(process, "disallowed_tools", default_disallowed))
    if allowed and "--allowedTools" not in command and "--allowed-tools" not in command:
        command.append("--allowedTools")
        command.extend(allowed)
    if disallowed and "--disallowedTools" not in command and "--disallowed-tools" not in command:
        command.append("--disallowedTools")
        command.extend(disallowed)


def command_for_process(
    base_command: list[str],
    process: dict[str, Any],
    settings: Settings | None = None,
) -> list[str]:
    command = list(base_command)
    if "--model" not in command and "-m" not in command:
        command.extend(["--model", process["agent_model"]])
    effort = (process.get("agent_effort") or "").strip()
    if effort and "--effort" not in command:
        if effort not in AGENT_EFFORT_VALUES:
            raise AppValidationError(f"Invalid agent_effort: {effort}")
        command.extend(["--effort", effort])
    apply_permissions(command, process, settings)
    return command
