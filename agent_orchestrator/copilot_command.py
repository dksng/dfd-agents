from __future__ import annotations

from typing import Any

from .agent_options import AGENT_EFFORT_VALUES
from .claude_command import permission_setting, split_tools
from .config import Settings
from .exceptions import AppValidationError

MODEL_ALIASES = {
    "claude-sonnet-4-6": "claude-sonnet-4.6",
    "claude-haiku-4-5": "claude-haiku-4.5",
}

TOOL_ALIASES = {
    "Read": "read",
    "Write": "write",
    "Edit": "write",
    "WebFetch": "url",
}


def has_option(command: list[str], *options: str) -> bool:
    for item in command:
        if item in options:
            return True
        if any(item.startswith(f"{option}=") for option in options if option.startswith("--")):
            return True
    return False


def copilot_model(model: str) -> str:
    value = (model or "").strip()
    if value.startswith("global.anthropic."):
        value = value.removeprefix("global.anthropic.")
    return MODEL_ALIASES.get(value, value)


def copilot_tool(tool: str) -> str:
    value = tool.strip()
    if value in TOOL_ALIASES:
        return TOOL_ALIASES[value]
    if value.startswith("Bash(") and value.endswith(")"):
        command = value.removeprefix("Bash(").removesuffix(")").strip()
        if command.endswith(" *"):
            return f"shell({command[:-2]}:*)"
        return f"shell({command})"
    return value


def copilot_tools(value: str) -> list[str]:
    return [copilot_tool(item) for item in split_tools(value)]


def apply_permissions(command: list[str], process: dict[str, Any], settings: Settings | None = None) -> None:
    default_mode = settings.default_permission_mode if settings else "default"
    mode = permission_setting(process, "permission_mode", default_mode)
    if mode == "bypassPermissions" and not has_option(command, "--allow-all", "--yolo"):
        command.append("--allow-all")
    if mode == "plan" and not has_option(command, "--plan"):
        command.append("--plan")
    if not has_option(command, "--no-ask-user"):
        command.append("--no-ask-user")

    process_allowed = (process.get("allowed_tools") or "").strip()
    default_allowed = settings.default_copilot_allowed_tools if settings else ""
    allowed = copilot_tools(process_allowed or default_allowed)
    if allowed and not has_option(command, "--allow-tool"):
        command.append(f"--allow-tool={','.join(allowed)}")

    process_disallowed = (process.get("disallowed_tools") or "").strip()
    default_disallowed = settings.default_copilot_disallowed_tools if settings else ""
    disallowed = copilot_tools(process_disallowed or default_disallowed)
    if disallowed and not has_option(command, "--deny-tool"):
        command.append(f"--deny-tool={','.join(disallowed)}")


def command_for_process(
    base_command: list[str],
    process: dict[str, Any],
    settings: Settings | None,
    prompt: str,
) -> list[str]:
    command = list(base_command)
    if not has_option(command, "--output-format"):
        command.append("--output-format=json")
    model = copilot_model(process.get("agent_model") or "")
    if model and not has_option(command, "--model"):
        command.append(f"--model={model}")
    effort = (process.get("agent_effort") or "").strip()
    if effort and not has_option(command, "--effort", "--reasoning-effort"):
        if effort not in AGENT_EFFORT_VALUES:
            raise AppValidationError(f"Invalid agent_effort: {effort}")
        command.append(f"--effort={effort}")
    apply_permissions(command, process, settings)
    if not has_option(command, "-p", "--prompt"):
        command.extend(["-p", prompt])
    return command
