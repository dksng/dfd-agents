import type { ArtifactNode, ProcessNode } from "../types";
import { normalizeGoalForStorage } from "./goal";

export function processPayload(draft: ProcessNode, artifacts: ArtifactNode[]): Record<string, unknown> {
  return {
    name: draft.name,
    agent_kind: draft.agent_kind,
    agent_model: draft.agent_model,
    agent_effort: draft.agent_effort,
    permission_mode: draft.permission_mode,
    allowed_tools: draft.allowed_tools,
    disallowed_tools: draft.disallowed_tools,
    goal_md: normalizeGoalForStorage(draft.goal_md, artifacts),
    template_id: draft.template_id,
    agents_md_append: draft.agents_md_append,
    execution_mode: draft.execution_mode,
    skills: draft.skills
  };
}

export function artifactPayload(draft: ArtifactNode): Record<string, unknown> {
  return {
    name: draft.name,
    type: draft.type,
    source_text: draft.source_text ?? null,
    source_url: draft.source_url ?? null,
    source_file_path: draft.source_file_path ?? null,
    spec_json: draft.spec_json ?? {}
  };
}
