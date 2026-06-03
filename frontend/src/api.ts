import type {
  AppSettings,
  ArtifactNode,
  CostSummary,
  HealthInfo,
  ProcessNode,
  RunDetail,
  SkillCandidate,
  Workflow,
  WorkflowExportDocument
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listWorkflows: () => request<Workflow[]>("/api/workflows"),
  createWorkflow: (name: string) =>
    request<Workflow>("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  getWorkflow: (id: string) => request<Workflow>(`/api/workflows/${id}`),
  exportWorkflow: async (id: string) => {
    const response = await fetch(`${API_BASE}/api/workflows/${id}/export`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || response.statusText);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    const quoted = disposition.match(/filename="([^"]+)"/)?.[1];
    const filename = encoded ? decodeURIComponent(encoded) : quoted || "workflow.workflow.json";
    return { document: (await response.json()) as WorkflowExportDocument, filename };
  },
  importWorkflow: (document: WorkflowExportDocument, name?: string) =>
    request<Workflow>("/api/workflows/import", {
      method: "POST",
      body: JSON.stringify({ document, name })
    }),
  deleteWorkflow: (id: string) =>
    request<{ ok: boolean }>(`/api/workflows/${id}`, { method: "DELETE" }),
  updateWorkflow: (id: string, payload: Partial<Workflow>, init: RequestInit = {}) =>
    request<Workflow>(`/api/workflows/${id}`, {
      ...init,
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  createProcess: (workflowId: string, payload: Partial<ProcessNode>) =>
    request<ProcessNode>(`/api/workflows/${workflowId}/processes`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteProcess: (id: string) =>
    request<{ ok: boolean }>(`/api/processes/${id}`, { method: "DELETE" }),
  updateProcessConfig: (id: string, payload: Record<string, unknown>, init: RequestInit = {}) =>
    request<ProcessNode>(`/api/processes/${id}/config`, {
      ...init,
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  createArtifact: (workflowId: string, payload: Partial<ArtifactNode>) =>
    request<ArtifactNode>(`/api/workflows/${workflowId}/artifacts`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateArtifact: (id: string, payload: Partial<ArtifactNode>, init: RequestInit = {}) =>
    request<ArtifactNode>(`/api/artifacts/${id}`, {
      ...init,
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  uploadArtifactSourceFile: async (id: string, file: File) => {
    const response = await fetch(
      `${API_BASE}/api/artifacts/${id}/source-file?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || response.statusText);
    }
    return response.json() as Promise<ArtifactNode>;
  },
  deleteArtifact: (id: string) =>
    request<{ ok: boolean }>(`/api/artifacts/${id}`, { method: "DELETE" }),
  createEdge: (
    workflowId: string,
    payload: {
      kind: "produces" | "consumes";
      process_id: string;
      artifact_id: string;
    }
  ) =>
    request(`/api/workflows/${workflowId}/edges`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteEdge: (id: string) =>
    request<{ ok: boolean }>(`/api/edges/${id}`, { method: "DELETE" }),
  listSkills: (refresh = false) =>
    request<{ skills: SkillCandidate[]; errors: string[] }>(
      `/api/skills?refresh=${String(refresh)}`
    ),
  runProcess: (id: string) =>
    request<RunDetail>(`/api/processes/${id}/run`, { method: "POST" }),
  resumeRun: (id: string, feedback_text: string) =>
    request<RunDetail>(`/api/runs/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({ feedback_text })
    }),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  answerQA: (id: string, answer_text: string) =>
    request(`/api/qa/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer_text })
    }),
  reviewRun: (id: string, action: "approve" | "reject", feedback_text: string) =>
    request<RunDetail>(`/api/runs/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ action, feedback_text })
    }),
  workflowCost: (id: string) => request<CostSummary>(`/api/workflows/${id}/cost`),
  getHealth: () => request<HealthInfo>("/api/health"),
  getSettings: () => request<AppSettings>("/api/settings"),
  updateSettings: (payload: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  getAgentsBase: (templateId: string) =>
    request<{ template_id: string; content: string }>(
      `/api/templates/${templateId}/agents-base`
    )
};

export function wsUrl(runId: string): string {
  if (API_BASE.startsWith("http")) {
    return `${API_BASE.replace(/^http/, "ws")}/ws/runs/${runId}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/runs/${runId}`;
}

export function artifactDownloadUrl(runId: string, artifactId: string): string {
  return `${API_BASE}/api/runs/${runId}/artifacts/${artifactId}/download`;
}
