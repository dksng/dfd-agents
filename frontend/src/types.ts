export type ArtifactType = "file" | "url" | "text";

export interface HealthInfo {
  status: string;
  agent_mode: string;
  claude_available: boolean;
  active_adapter: "mock" | "claude";
  claude_command: string;
  default_permission_mode: string;
  default_allowed_tools: string;
  default_disallowed_tools: string;
}

export interface AppSettings {
  skill_repos: string[];
  config_root: string;
  skill_cache_root: string;
  notify_events: string[];
  notify_enabled: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

export interface ModelCatalog {
  currency: string;
  default_model: string;
  models: ModelOption[];
}

export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;

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
  agent_kind: string;
  agent_model: string;
  agent_effort: string;
  permission_mode: string;
  allowed_tools: string;
  disallowed_tools: string;
  goal_md: string;
  template_id: string;
  agents_md_append: string;
  pos_x: number;
  pos_y: number;
  execution_mode: string;
  skills: SkillSelection[];
  runs: RunSummary[];
}

export interface ArtifactNode {
  id: string;
  workflow_id: string;
  name: string;
  type: ArtifactType;
  pos_x: number;
  pos_y: number;
  source_text?: string | null;
  source_url?: string | null;
  source_file_path?: string | null;
  spec_json: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  workflow_id: string;
  kind: "produces" | "consumes";
  process_id: string;
  artifact_id: string;
}

export interface Workflow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  layout_json: Record<string, unknown>;
  processes: ProcessNode[];
  artifacts: ArtifactNode[];
  edges: WorkflowEdge[];
}

export type WorkflowExportDocument = Record<string, unknown>;

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
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cost_usd: number;
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
  cache_write_5m: number;
  cache_write_1h: number;
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
  artifact_id: string;
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
  cache_write_5m: number;
  cache_write_1h: number;
  cost_usd: number;
}

export interface AttentionSummary {
  workflow_id: string;
  waiting_qa: number;
  in_review: number;
  failed: number;
}

export interface GlobalEvent {
  type: string;
  run_id: string;
  process_id: string;
  workflow_id: string;
  /** For type==="graph": the structural change, e.g. "process.create", "edge.delete". */
  action?: string;
  /** Id of the client that made the change (so it can ignore its own echo). */
  origin?: string;
  payload: Record<string, unknown>;
}
