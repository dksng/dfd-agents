export type ArtifactType = "file" | "url" | "text";
export type PortDirection = "in" | "out";

export interface ArtifactPort {
  id: string;
  process_id: string;
  direction: PortDirection;
  artifact_name: string;
  artifact_type: ArtifactType;
  spec_json: Record<string, unknown>;
}

export interface SkillSelection {
  skill_name: string;
  skill_source: "local" | "git";
  skill_ref: string;
}

export interface SkillCandidate {
  name: string;
  skill_source: "local" | "git";
  skill_ref: string;
  path: string;
  description: string;
}

export interface ProcessNode {
  id: string;
  workflow_id: string;
  name: string;
  type: string;
  agent_kind: string;
  agent_model: string;
  goal_md: string;
  template_id: string;
  agents_md_append: string;
  pos_x: number;
  pos_y: number;
  execution_mode: string;
  ports: ArtifactPort[];
  skills: SkillSelection[];
  runs: RunSummary[];
}

export interface WorkflowEdge {
  id: string;
  workflow_id: string;
  from_process_id: string;
  from_port_id: string;
  to_process_id: string;
  to_port_id: string;
}

export interface Workflow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  layout_json: Record<string, unknown>;
  processes: ProcessNode[];
  edges: WorkflowEdge[];
}

export interface RunSummary {
  id: string;
  process_id: string;
  parent_run_id?: string | null;
  status: string;
  session_id?: string | null;
  started_at: string;
  ended_at?: string | null;
  input_snapshot_json: Record<string, unknown>;
  output_snapshot_json: Record<string, unknown>;
  workdir_path: string;
}

export interface RunLog {
  id: string;
  run_id: string;
  ts: string;
  level: string;
  message: string;
  raw_json: Record<string, unknown>;
}

export interface TokenUsage {
  id: string;
  run_id: string;
  ts: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  model: string;
}

export interface QAItem {
  id: string;
  run_id: string;
  question_text: string;
  answer_text?: string | null;
  status: string;
  created_at: string;
  answered_at?: string | null;
}

export interface ReviewItem {
  id: string;
  run_id: string;
  status: string;
  feedback_text: string;
  created_at: string;
  resolved_at?: string | null;
}

export interface ArtifactValue {
  id: string;
  run_id: string;
  port_id: string;
  artifact_type: ArtifactType;
  file_path?: string | null;
  url?: string | null;
  text_value?: string | null;
}

export interface RunDetail extends RunSummary {
  logs: RunLog[];
  token_usage: TokenUsage[];
  qa: QAItem[];
  reviews: ReviewItem[];
  artifacts: ArtifactValue[];
}

export interface CostSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
}

