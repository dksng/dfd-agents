from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

import yaml

from .config import Settings
from .db import Store
from .skills import SkillRegistry


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._")
    return cleaned or "artifact"


class WorkspaceBuilder:
    def __init__(self, settings: Settings, store: Store, skill_registry: SkillRegistry):
        self.settings = settings
        self.store = store
        self.skill_registry = skill_registry

    def build(self, run_id: str, process_id: str, *, parent_run: dict[str, Any] | None = None, feedback_text: str = "") -> dict[str, Any]:
        process = self.store.get_process(process_id)
        workflow_id = process["workflow_id"]
        workdir = self.settings.workflow_root / workflow_id / "runs" / run_id
        if workdir.exists():
            shutil.rmtree(workdir)
        (workdir / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
        (workdir / "input").mkdir(parents=True, exist_ok=True)
        (workdir / "output").mkdir(parents=True, exist_ok=True)
        (workdir / "utils").mkdir(parents=True, exist_ok=True)

        for skill in process["skills"]:
            self.skill_registry.copy_skill(
                skill["skill_name"],
                skill["skill_source"],
                skill["skill_ref"],
                workdir / ".claude" / "skills",
            )

        inputs = self._collect_inputs(process, workdir)
        outputs = self._expected_outputs(process)

        (workdir / "input" / "input.yaml").write_text(
            yaml.safe_dump({"input": inputs}, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        (workdir / "output" / "output.yaml").write_text(
            yaml.safe_dump({"output": outputs}, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

        self._write_agents(process, workdir)
        (workdir / "Goal.md").write_text(self._resolve_goal(process), encoding="utf-8")
        if feedback_text:
            (workdir / "Feedback.md").write_text(feedback_text, encoding="utf-8")
        if parent_run:
            (workdir / "PreviousRun.md").write_text(
                f"Parent run: {parent_run['id']}\nPrevious session: {parent_run.get('session_id') or ''}\n",
                encoding="utf-8",
            )
        self._copy_utils(workdir)
        return {"input": inputs, "output": outputs, "workdir": str(workdir)}

    def _collect_inputs(self, process: dict[str, Any], workdir: Path) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        for edge in self.store.get_edges_for_process(process["id"], "consumes"):
            artifact = self.store.get_artifact(edge["artifact_id"])
            value = self._artifact_source_default(artifact, workdir)
            producer = next(iter(self.store.get_edges_for_artifact(artifact["id"], "produces")), None)
            if producer:
                upstream_run = self.store.latest_approved_run(producer["process_id"])
                if upstream_run:
                    upstream_value = next(
                        (item for item in upstream_run["artifacts"] if item["artifact_id"] == artifact["id"]),
                        None,
                    )
                    if upstream_value:
                        value = self._input_from_upstream(artifact, upstream_run, upstream_value, workdir)
            values.append(value)
        return values

    def _input_from_upstream(
        self,
        artifact: dict[str, Any],
        upstream_run: dict[str, Any],
        upstream_value: dict[str, Any],
        workdir: Path,
    ) -> dict[str, Any]:
        artifact_type = upstream_value.get("artifact_type") or artifact["type"]
        item = {"id": artifact["id"], "name": artifact["name"], "type": artifact_type}
        if artifact_type == "file":
            upstream_workdir = Path(upstream_run["workdir_path"]).resolve()
            rel_path = upstream_value.get("file_path") or f"output/{safe_name(artifact['name'])}.md"
            source = (upstream_workdir / rel_path).resolve()
            filename = safe_name(Path(rel_path).name)
            target = workdir / "input" / filename
            if source.is_relative_to(upstream_workdir) and source.exists():
                shutil.copy2(source, target)
            else:
                target.write_text("", encoding="utf-8")
            item["path"] = f"input/{filename}"
        elif artifact_type == "url":
            item["url"] = upstream_value.get("url") or ""
        else:
            item["text"] = upstream_value.get("text_value") or ""
        return item

    def _artifact_source_default(self, artifact: dict[str, Any], workdir: Path) -> dict[str, Any]:
        item = {"id": artifact["id"], "name": artifact["name"], "type": artifact["type"]}
        if artifact["type"] == "file":
            source_path = artifact.get("source_file_path") or ""
            filename = safe_name(Path(source_path).name if source_path else artifact["name"])
            target = workdir / "input" / filename
            source = Path(source_path).expanduser() if source_path else None
            if source and not source.is_absolute():
                source = Path.cwd() / source
            if source and source.exists() and source.is_file():
                shutil.copy2(source, target)
            else:
                target.write_text("", encoding="utf-8")
            item["path"] = f"input/{filename}"
        elif artifact["type"] == "url":
            item["url"] = artifact.get("source_url") or ""
        else:
            item["text"] = artifact.get("source_text") or ""
        return item

    def _expected_outputs(self, process: dict[str, Any]) -> list[dict[str, Any]]:
        outputs: list[dict[str, Any]] = []
        for edge in self.store.get_edges_for_process(process["id"], "produces"):
            artifact = self.store.get_artifact(edge["artifact_id"])
            spec = artifact.get("spec_json") or {}
            item = {"id": artifact["id"], "name": artifact["name"], "type": artifact["type"]}
            if artifact["type"] == "file":
                item["path"] = spec.get("path", f"output/{safe_name(artifact['name'])}.md")
            elif artifact["type"] == "url":
                item["url"] = spec.get("url", "")
            else:
                item["text"] = spec.get("text", "")
            outputs.append(item)
        return outputs

    def _write_agents(self, process: dict[str, Any], workdir: Path) -> None:
        template_id = process.get("template_id") or "base"
        template = self.settings.template_root / template_id / "AGENTS.md"
        if not template.exists():
            template = self.settings.template_root / "base" / "AGENTS.md"
        body = template.read_text(encoding="utf-8")
        append = process.get("agents_md_append") or ""
        if append:
            body = f"{body.rstrip()}\n\n## Process-specific Instructions\n\n{append.strip()}\n"
        (workdir / "AGENTS.md").write_text(body, encoding="utf-8")

    def _resolve_goal(self, process: dict[str, Any]) -> str:
        goal = process.get("goal_md") or ""
        for edge in self.store.get_edges_for_process(process["id"]):
            artifact = self.store.get_artifact(edge["artifact_id"])
            goal = goal.replace(f"{{{{artifact:{artifact['id']}}}}}", f"{{{artifact['name']}}}")
        return goal

    def _copy_utils(self, workdir: Path) -> None:
        source = self.settings.template_root / "base" / "utils"
        for util in source.glob("*.py"):
            shutil.copy2(util, workdir / "utils" / util.name)
