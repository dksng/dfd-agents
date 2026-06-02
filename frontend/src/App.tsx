import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange
} from "@xyflow/react";
import {
  Check,
  Download,
  FileText,
  Link,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Type,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, artifactDownloadUrl, wsUrl } from "./api";
import type {
  ArtifactNode,
  ArtifactType,
  ArtifactValue,
  CostSummary,
  HealthInfo,
  ProcessNode,
  RunDetail,
  SkillCandidate,
  Workflow
} from "./types";

type ProcessNodeData = {
  process: ProcessNode;
  selected: boolean;
  inputCount: number;
  outputCount: number;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
};

type ArtifactNodeData = {
  artifact: ArtifactNode;
  selected: boolean;
  producerName?: string;
  consumerCount: number;
  onSelect: (id: string) => void;
};

type FlowNodeData = ProcessNodeData | ArtifactNodeData;

function StatusPill({ status }: { status?: string }) {
  return <span className={`status ${status || "draft"}`}>{status || "draft"}</span>;
}

function ArtifactIcon({ type }: { type: ArtifactType }) {
  if (type === "file") {
    return <FileText size={16} />;
  }
  if (type === "url") {
    return <Link size={16} />;
  }
  return <Type size={16} />;
}

function ProcessFlowNode({ data }: { data: ProcessNodeData }) {
  const latest = data.process.runs?.[0];
  return (
    <div
      className={`flow-node process-node ${data.selected ? "selected" : ""}`}
      onClick={() => data.onSelect(data.process.id)}
    >
      <Handle id="consumes" type="target" position={Position.Left} />
      <Handle id="produces" type="source" position={Position.Right} />
      <div className="node-topline">
        <strong>{data.process.name}</strong>
        <button
          className="icon-button"
          title="Run"
          onClick={(event) => {
            event.stopPropagation();
            data.onRun(data.process.id);
          }}
        >
          <Play size={15} />
        </button>
      </div>
      <div className="node-meta">
        <span>{data.process.type}</span>
        <StatusPill status={latest?.status} />
      </div>
      <div className="node-stats">
        <span>{data.inputCount} inputs</span>
        <span>{data.outputCount} outputs</span>
      </div>
    </div>
  );
}

function ArtifactFlowNode({ data }: { data: ArtifactNodeData }) {
  return (
    <div
      className={`flow-node artifact-node ${data.selected ? "selected" : ""}`}
      onClick={() => data.onSelect(data.artifact.id)}
    >
      <Handle id="produces" type="target" position={Position.Left} />
      <Handle id="consumes" type="source" position={Position.Right} />
      <div className="node-topline">
        <strong>{data.artifact.name}</strong>
        <ArtifactIcon type={data.artifact.type} />
      </div>
      <div className="node-meta">
        <span>{data.artifact.type}</span>
        <span>{data.producerName ?? "source"}</span>
      </div>
      <div className="node-stats">
        <span>{data.consumerCount} consumers</span>
      </div>
    </div>
  );
}

const nodeTypes = { process: ProcessFlowNode, artifact: ArtifactFlowNode };

function totalUsage(run: RunDetail | null): CostSummary {
  return (run?.token_usage ?? []).reduce(
    (acc, item) => ({
      input_tokens: acc.input_tokens + item.input_tokens,
      output_tokens: acc.output_tokens + item.output_tokens,
      cache_read: acc.cache_read + item.cache_read,
      cache_write: acc.cache_write + item.cache_write,
      cost_usd: acc.cost_usd + item.cost_usd
    }),
    { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }
  );
}

function appendUnique<T extends { id: string }>(items: T[], item: T): T[] {
  if (items.some((current) => current.id === item.id)) {
    return items;
  }
  return [...items, item];
}

function skillKey(skill: Pick<SkillCandidate, "skill_source" | "skill_ref">): string {
  return `${skill.skill_source}:${skill.skill_ref}`;
}

function simpleLineDiff(before: string, after: string): string {
  if (before === after) {
    return "No changes.";
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  return [
    ...beforeLines.map((line) => `- ${line}`),
    ...afterLines.map((line) => `+ ${line}`)
  ].join("\n");
}

function artifactSpecText(artifact: ArtifactNode | null, key: string): string {
  const value = artifact?.spec_json?.[key];
  return typeof value === "string" ? value : "";
}

const MODEL_OPTIONS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5"
];

const EFFORT_OPTIONS = ["low", "medium", "high"];

// Goal.md は表示名 `{artifact name}` で編集・保存する。
// 旧形式の `{{artifact:<id>}}` トークンは読み込み時に表示名へ正規化する。
function artifactDisplayLabel(artifact: ArtifactNode, artifacts: ArtifactNode[]): string {
  const duplicateName = artifacts.some((item) => item.id !== artifact.id && item.name === artifact.name);
  return duplicateName ? `${artifact.name} #${artifact.id.slice(-6)}` : artifact.name;
}

function normalizeGoalForDisplay(goal: string, artifacts: ArtifactNode[]): string {
  return goal.replace(/\{\{artifact:([^}]+)\}\}/g, (_match, id: string) => {
    const artifact = artifacts.find((item) => item.id === id);
    return artifact ? `{${artifactDisplayLabel(artifact, artifacts)}}` : `{${id}}`;
  });
}

function normalizeGoalForStorage(goal: string, artifacts: ArtifactNode[]): string {
  const nameCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    nameCounts.set(artifact.name, (nameCounts.get(artifact.name) ?? 0) + 1);
  }
  const artifactByLabel = new Map<string, ArtifactNode>();
  const artifactByUniqueName = new Map<string, ArtifactNode>();
  for (const artifact of artifacts) {
    artifactByLabel.set(artifactDisplayLabel(artifact, artifacts), artifact);
    if ((nameCounts.get(artifact.name) ?? 0) === 1) {
      artifactByUniqueName.set(artifact.name, artifact);
    }
  }
  return goal.replace(/\{([^{}]+)\}/g, (match, label: string) => {
    const artifact = artifactByLabel.get(label) ?? artifactByUniqueName.get(label);
    return artifact ? `{{artifact:${artifact.id}}}` : match;
  });
}

function artifactsConnectedToProcess(workflow: Workflow | null, processId: string): ArtifactNode[] {
  if (!workflow) {
    return [];
  }
  const connectedIds = new Set(
    workflow.edges
      .filter((edge) => edge.process_id === processId)
      .map((edge) => edge.artifact_id)
  );
  return workflow.artifacts.filter((artifact) => connectedIds.has(artifact.id));
}

// autosave / 明示保存で送るペイロード（位置はドラッグ側で別途保存するため含めない）。
function processPayload(draft: ProcessNode, artifacts: ArtifactNode[]): Record<string, unknown> {
  return {
    name: draft.name,
    type: draft.type,
    agent_kind: draft.agent_kind,
    agent_model: draft.agent_model,
    agent_effort: draft.agent_effort,
    goal_md: normalizeGoalForStorage(draft.goal_md, artifacts),
    template_id: draft.template_id,
    agents_md_append: draft.agents_md_append,
    execution_mode: draft.execution_mode,
    skills: draft.skills
  };
}

function artifactPayload(draft: ArtifactNode): Record<string, unknown> {
  return {
    name: draft.name,
    type: draft.type,
    source_text: draft.source_text ?? null,
    source_url: draft.source_url ?? null,
    source_file_path: draft.source_file_path ?? null,
    spec_json: draft.spec_json ?? {}
  };
}

export function App() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>("");
  const [processDraft, setProcessDraft] = useState<ProcessNode | null>(null);
  const [artifactDraft, setArtifactDraft] = useState<ArtifactNode | null>(null);
  const [skills, setSkills] = useState<SkillCandidate[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string>("");
  const [feedback, setFeedback] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [diffBaseId, setDiffBaseId] = useState("");
  const [diffTargetId, setDiffTargetId] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [goalCursor, setGoalCursor] = useState(0);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [agentsBase, setAgentsBase] = useState("");
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>([]);
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const workflowIdRef = useRef<string | null>(null);
  const savedProcessRef = useRef<string>("");
  const savedArtifactRef = useRef<string>("");
  const processSaveSeqRef = useRef(0);
  const artifactSaveSeqRef = useRef(0);
  const workflowSaveSeqRef = useRef(0);
  const processSaveAbortRef = useRef<AbortController | null>(null);
  const artifactSaveAbortRef = useRef<AbortController | null>(null);
  const workflowSaveAbortRef = useRef<AbortController | null>(null);

  const loadWorkflow = useCallback(async (id: string) => {
    const data = await api.getWorkflow(id);
    setWorkflow(data);
    setCost(await api.workflowCost(id));
    return data;
  }, []);

  const selectProcess = useCallback((id: string) => {
    setSelectedProcessId(id);
    setSelectedArtifactId("");
  }, []);

  const selectArtifact = useCallback((id: string) => {
    setSelectedArtifactId(id);
    setSelectedProcessId("");
  }, []);

  const loadInitial = useCallback(async () => {
    try {
      let list = await api.listWorkflows();
      if (list.length === 0) {
        const created = await api.createWorkflow("Default Workflow");
        list = [created];
      }
      setWorkflows(list);
      const full = await loadWorkflow(list[0].id);
      setSelectedProcessId(full.processes[0]?.id ?? "");
      const skillResponse = await api.listSkills(false);
      setSkills(skillResponse.skills);
      api.getHealth().then(setHealth).catch(() => undefined);
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadWorkflow]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    workflowIdRef.current = workflow?.id ?? null;
    setWorkflowNameDraft(workflow?.name ?? "");
  }, [workflow?.id, workflow?.name]);

  const selectedProcess = useMemo(
    () => workflow?.processes.find((process) => process.id === selectedProcessId) ?? null,
    [selectedProcessId, workflow]
  );

  const selectedArtifact = useMemo(
    () => workflow?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null,
    [selectedArtifactId, workflow]
  );

  const artifactById = useMemo(
    () => new Map((workflow?.artifacts ?? []).map((artifact) => [artifact.id, artifact])),
    [workflow]
  );

  // 選択した工程が「変わったとき」だけドラフトを読み込む（id をキーに）。
  // workflow の再取得（autosave/コストポーリング）では再読込しないので入力中も消えない。
  useEffect(() => {
    if (!selectedProcess) {
      setProcessDraft(null);
      savedProcessRef.current = "";
      setAgentsBase("");
      setSelectedRun(null);
      return;
    }
    const draft = structuredClone(selectedProcess);
    const connectedArtifacts = artifactsConnectedToProcess(workflow, selectedProcess.id);
    draft.goal_md = normalizeGoalForDisplay(draft.goal_md, connectedArtifacts);
    setProcessDraft(draft);
    savedProcessRef.current = JSON.stringify(processPayload(draft, connectedArtifacts));
    setDiffBaseId(selectedProcess.runs?.[1]?.id ?? "");
    setDiffTargetId(selectedProcess.runs?.[0]?.id ?? "");
    setDiffText("");
    api.getAgentsBase(selectedProcess.template_id || "base").then((res) => setAgentsBase(res.content)).catch(() => setAgentsBase(""));
    const latestRun = selectedProcess.runs?.[0];
    if (latestRun) {
      void api.getRun(latestRun.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
    } else {
      setSelectedRun(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProcessId]);

  useEffect(() => {
    if (!selectedArtifact) {
      setArtifactDraft(null);
      savedArtifactRef.current = "";
      return;
    }
    const draft = structuredClone(selectedArtifact);
    setArtifactDraft(draft);
    savedArtifactRef.current = JSON.stringify(artifactPayload(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId]);

  // 工程ドラフトのデバウンス自動保存。
  useEffect(() => {
    if (!processDraft) {
      return;
    }
    const connectedArtifacts = artifactsConnectedToProcess(workflow, processDraft.id);
    const payload = processPayload(processDraft, connectedArtifacts);
    const serialized = JSON.stringify(payload);
    if (serialized === savedProcessRef.current) {
      return;
    }
    processSaveAbortRef.current?.abort();
    const controller = new AbortController();
    const saveSeq = ++processSaveSeqRef.current;
    const timer = window.setTimeout(() => {
      void api
        .updateProcessConfig(processDraft.id, payload, { signal: controller.signal })
        .then(() => {
          if (controller.signal.aborted || saveSeq !== processSaveSeqRef.current) {
            return undefined;
          }
          savedProcessRef.current = serialized;
          if (workflowIdRef.current) {
            return loadWorkflow(workflowIdRef.current);
          }
          return undefined;
        })
        .catch((exc) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(String(exc));
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [processDraft, workflow, loadWorkflow]);

  // 成果物ドラフトのデバウンス自動保存。
  useEffect(() => {
    if (!artifactDraft) {
      return;
    }
    const serialized = JSON.stringify(artifactPayload(artifactDraft));
    if (serialized === savedArtifactRef.current) {
      return;
    }
    artifactSaveAbortRef.current?.abort();
    const controller = new AbortController();
    const saveSeq = ++artifactSaveSeqRef.current;
    const timer = window.setTimeout(() => {
      void api
        .updateArtifact(artifactDraft.id, artifactPayload(artifactDraft), { signal: controller.signal })
        .then(() => {
          if (controller.signal.aborted || saveSeq !== artifactSaveSeqRef.current) {
            return undefined;
          }
          savedArtifactRef.current = serialized;
          if (workflowIdRef.current) {
            return loadWorkflow(workflowIdRef.current);
          }
          return undefined;
        })
        .catch((exc) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(String(exc));
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [artifactDraft, loadWorkflow]);

  // ワークフロー名のデバウンス自動保存。
  useEffect(() => {
    if (!workflow || workflowNameDraft === workflow.name) {
      return;
    }
    const id = workflow.id;
    workflowSaveAbortRef.current?.abort();
    const controller = new AbortController();
    const saveSeq = ++workflowSaveSeqRef.current;
    const timer = window.setTimeout(() => {
      void api
        .updateWorkflow(id, { name: workflowNameDraft }, { signal: controller.signal })
        .then(() => {
          if (controller.signal.aborted || saveSeq !== workflowSaveSeqRef.current) {
            return;
          }
          setWorkflows((items) => items.map((item) => (item.id === id ? { ...item, name: workflowNameDraft } : item)));
          setWorkflow((current) => (current && current.id === id ? { ...current, name: workflowNameDraft } : current));
        })
        .catch((exc) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(String(exc));
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [workflowNameDraft, workflow]);

  useEffect(() => {
    if (!selectedRun?.id) {
      return;
    }
    const socket = new WebSocket(wsUrl(selectedRun.id));
    socket.onopen = () => setWsConnected(true);
    socket.onclose = () => setWsConnected(false);
    socket.onerror = () => setWsConnected(false);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as { type: string; payload: Record<string, unknown> };
      if (event.type === "log") {
        setSelectedRun((current) =>
          current && current.id === selectedRun.id
            ? {
                ...current,
                logs: appendUnique(
                  current.logs,
                  event.payload as unknown as RunDetail["logs"][number]
                )
              }
            : current
        );
        return;
      }
      if (event.type === "usage") {
        setSelectedRun((current) =>
          current && current.id === selectedRun.id
            ? {
                ...current,
                token_usage: appendUnique(
                  current.token_usage,
                  event.payload as unknown as RunDetail["token_usage"][number]
                )
              }
            : current
        );
        return;
      }
      void api.getRun(selectedRun.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
      const workflowId = workflowIdRef.current;
      if (workflowId) {
        void loadWorkflow(workflowId);
      }
    };
    return () => {
      socket.close();
      setWsConnected(false);
    };
  }, [loadWorkflow, selectedRun?.id]);

  useEffect(() => {
    if (
      !selectedRun?.id ||
      wsConnected ||
      !["running", "waiting_qa", "draft"].includes(selectedRun.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void api.getRun(selectedRun.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
      if (workflowIdRef.current) {
        void loadWorkflow(workflowIdRef.current);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadWorkflow, selectedRun?.id, selectedRun?.status, wsConnected]);

  const computedNodes = useMemo<Node<FlowNodeData>[]>(
    () => {
      const producerByArtifact = new Map<string, string>();
      const consumersByArtifact = new Map<string, number>();
      const inputCountByProcess = new Map<string, number>();
      const outputCountByProcess = new Map<string, number>();
      for (const edge of workflow?.edges ?? []) {
        if (edge.kind === "produces") {
          producerByArtifact.set(edge.artifact_id, edge.process_id);
          outputCountByProcess.set(edge.process_id, (outputCountByProcess.get(edge.process_id) ?? 0) + 1);
        } else {
          consumersByArtifact.set(edge.artifact_id, (consumersByArtifact.get(edge.artifact_id) ?? 0) + 1);
          inputCountByProcess.set(edge.process_id, (inputCountByProcess.get(edge.process_id) ?? 0) + 1);
        }
      }
      const processNameById = new Map((workflow?.processes ?? []).map((process) => [process.id, process.name]));
      return [
        ...(workflow?.processes ?? []).map((process) => ({
          id: process.id,
          type: "process",
          position: { x: process.pos_x, y: process.pos_y },
          data: {
            process,
            selected: process.id === selectedProcessId,
            inputCount: inputCountByProcess.get(process.id) ?? 0,
            outputCount: outputCountByProcess.get(process.id) ?? 0,
            onSelect: selectProcess,
            onRun: (id: string) => void runProcess(id)
          }
        })),
        ...(workflow?.artifacts ?? []).map((artifact) => {
          const producerId = producerByArtifact.get(artifact.id);
          return {
            id: artifact.id,
            type: "artifact",
            position: { x: artifact.pos_x, y: artifact.pos_y },
            data: {
              artifact,
              selected: artifact.id === selectedArtifactId,
              producerName: producerId ? processNameById.get(producerId) : undefined,
              consumerCount: consumersByArtifact.get(artifact.id) ?? 0,
              onSelect: selectArtifact
            }
          };
        })
      ];
    },
    [selectArtifact, selectProcess, selectedArtifactId, selectedProcessId, workflow]
  );

  // ReactFlow を制御コンポーネント化：computedNodes を同期しつつ、ドラッグ中の
  // 位置変更は onNodesChange でローカル適用する（これが無いとドラッグで動かない）。
  useEffect(() => {
    setNodes(computedNodes);
  }, [computedNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current) as Node<FlowNodeData>[]);
  }, []);

  const edges = useMemo<Edge[]>(
    () =>
      (workflow?.edges ?? []).map((edge) => ({
        id: edge.id,
        source: edge.kind === "produces" ? edge.process_id : edge.artifact_id,
        target: edge.kind === "produces" ? edge.artifact_id : edge.process_id,
        sourceHandle: edge.kind === "produces" ? "produces" : "consumes",
        targetHandle: edge.kind === "produces" ? "produces" : "consumes",
        markerEnd: { type: MarkerType.ArrowClosed },
        className: `workflow-edge ${edge.kind}`
      })),
    [workflow]
  );

  const goalArtifacts = useMemo(() => {
    return processDraft ? artifactsConnectedToProcess(workflow, processDraft.id) : [];
  }, [processDraft?.id, workflow]);

  async function addProcess() {
    if (!workflow) {
      return;
    }
    const created = await api.createProcess(workflow.id, {
      name: `Process ${workflow.processes.length + 1}`,
      type: "implement",
      pos_x: 140 + workflow.processes.length * 42,
      pos_y: 140 + workflow.processes.length * 34
    });
    await loadWorkflow(workflow.id);
    selectProcess(created.id);
  }

  async function addArtifact(type: ArtifactType = "text") {
    if (!workflow) {
      return;
    }
    const created = await api.createArtifact(workflow.id, {
      name: `Artifact ${workflow.artifacts.length + 1}`,
      type,
      pos_x: 460 + workflow.artifacts.length * 38,
      pos_y: 160 + workflow.artifacts.length * 32
    });
    await loadWorkflow(workflow.id);
    selectArtifact(created.id);
  }

  async function saveProcess() {
    if (!processDraft || !workflow) {
      return;
    }
    processSaveAbortRef.current?.abort();
    const payload = processPayload(processDraft, artifactsConnectedToProcess(workflow, processDraft.id));
    ++processSaveSeqRef.current;
    savedProcessRef.current = JSON.stringify(payload);
    await api.updateProcessConfig(processDraft.id, payload);
    await loadWorkflow(workflow.id);
  }

  async function saveArtifact() {
    if (!artifactDraft || !workflow) {
      return;
    }
    artifactSaveAbortRef.current?.abort();
    const payload = artifactPayload(artifactDraft);
    ++artifactSaveSeqRef.current;
    savedArtifactRef.current = JSON.stringify(payload);
    await api.updateArtifact(artifactDraft.id, payload);
    await loadWorkflow(workflow.id);
  }

  async function runProcess(processId: string) {
    const run = await api.runProcess(processId);
    setSelectedRun(run);
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }

  async function deleteSelectedProcess() {
    if (!processDraft || !workflow) {
      return;
    }
    await api.deleteProcess(processDraft.id);
    setSelectedProcessId("");
    await loadWorkflow(workflow.id);
  }

  async function deleteSelectedArtifact() {
    if (!artifactDraft || !workflow) {
      return;
    }
    await api.deleteArtifact(artifactDraft.id);
    setSelectedArtifactId("");
    await loadWorkflow(workflow.id);
  }

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!workflow || !connection.source || !connection.target) {
        return;
      }
      const sourceIsProcess = workflow.processes.some((process) => process.id === connection.source);
      const targetIsProcess = workflow.processes.some((process) => process.id === connection.target);
      const sourceIsArtifact = workflow.artifacts.some((artifact) => artifact.id === connection.source);
      const targetIsArtifact = workflow.artifacts.some((artifact) => artifact.id === connection.target);
      if (sourceIsProcess && targetIsArtifact) {
        await api.createEdge(workflow.id, {
          kind: "produces",
          process_id: connection.source,
          artifact_id: connection.target
        });
      } else if (sourceIsArtifact && targetIsProcess) {
        await api.createEdge(workflow.id, {
          kind: "consumes",
          process_id: connection.target,
          artifact_id: connection.source
        });
      } else {
        setError("Connect process to artifact, or artifact to process.");
        return;
      }
      await loadWorkflow(workflow.id);
    },
    [loadWorkflow, workflow]
  );

  async function updateNodePosition(nodeId: string, x: number, y: number) {
    if (!workflow) {
      return;
    }
    if (workflow.processes.some((process) => process.id === nodeId)) {
      await api.updateProcessConfig(nodeId, { pos_x: x, pos_y: y });
    } else if (workflow.artifacts.some((artifact) => artifact.id === nodeId)) {
      await api.updateArtifact(nodeId, { pos_x: x, pos_y: y });
    }
    await loadWorkflow(workflow.id);
  }

  function updateProcessDraft<K extends keyof ProcessNode>(key: K, value: ProcessNode[K]) {
    setProcessDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function updateArtifactDraft<K extends keyof ArtifactNode>(key: K, value: ArtifactNode[K]) {
    setArtifactDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function updateArtifactSpec(key: string, value: string) {
    setArtifactDraft((current) =>
      current
        ? {
            ...current,
            spec_json: {
              ...(current.spec_json ?? {}),
              [key]: value
            }
          }
        : current
    );
  }

  function toggleSkill(skill: SkillCandidate, checked: boolean) {
    setProcessDraft((current) => {
      if (!current) {
        return current;
      }
      const existing = current.skills.filter(
        (item) => `${item.skill_source}:${item.skill_ref}` !== skillKey(skill)
      );
      if (!checked) {
        return { ...current, skills: existing };
      }
      return {
        ...current,
        skills: [
          ...existing,
          {
            skill_name: skill.name,
            skill_source: skill.skill_source,
            skill_ref: skill.skill_ref
          }
        ]
      };
    });
  }

  function onGoalChange(value: string, cursor: number) {
    updateProcessDraft("goal_md", value);
    setGoalCursor(cursor);
    setSuggestOpen(cursor > 0 && value[cursor - 1] === "/");
  }

  function insertArtifactToken(artifact: ArtifactNode) {
    if (!processDraft) {
      return;
    }
    const before = processDraft.goal_md.slice(0, Math.max(goalCursor - 1, 0));
    const after = processDraft.goal_md.slice(goalCursor);
    const token = `{${artifactDisplayLabel(artifact, goalArtifacts)}}`;
    const next = `${before}${token}${after}`;
    updateProcessDraft("goal_md", next);
    setSuggestOpen(false);
    window.setTimeout(() => {
      const position = before.length + token.length;
      goalRef.current?.setSelectionRange(position, position);
      goalRef.current?.focus();
    }, 0);
  }

  async function answerQA() {
    const pending = selectedRun?.qa.find((item) => item.status === "pending");
    if (!pending || !qaAnswer.trim()) {
      return;
    }
    await api.answerQA(pending.id, qaAnswer);
    setQaAnswer("");
    setSelectedRun(await api.getRun(selectedRun!.id));
  }

  async function review(action: "approve" | "reject") {
    if (!selectedRun) {
      return;
    }
    const result = await api.reviewRun(selectedRun.id, action, feedback);
    setSelectedRun(result);
    setFeedback("");
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }

  async function resumeSelectedRun() {
    if (!selectedRun || selectedRun.status !== "failed") {
      return;
    }
    const result = await api.resumeRun(selectedRun.id, feedback);
    setSelectedRun(result);
    setFeedback("");
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }

  async function artifactContent(run: RunDetail, artifact: ArtifactValue): Promise<string> {
    if (artifact.artifact_type === "text") {
      return artifact.text_value ?? "";
    }
    if (artifact.artifact_type === "url") {
      return artifact.url ?? "";
    }
    const response = await fetch(artifactDownloadUrl(run.id, artifact.artifact_id));
    if (!response.ok) {
      return `[download failed: ${response.status}]`;
    }
    return response.text();
  }

  async function loadRunDiff() {
    if (!diffBaseId || !diffTargetId || diffBaseId === diffTargetId) {
      setDiffText("");
      return;
    }
    setDiffLoading(true);
    try {
      const [base, target] = await Promise.all([api.getRun(diffBaseId), api.getRun(diffTargetId)]);
      const artifactIds = Array.from(new Set([
        ...base.artifacts.map((artifact) => artifact.artifact_id),
        ...target.artifacts.map((artifact) => artifact.artifact_id)
      ]));
      const sections: string[] = [];
      for (const artifactId of artifactIds) {
        const beforeArtifact = base.artifacts.find((artifact) => artifact.artifact_id === artifactId);
        const afterArtifact = target.artifacts.find((artifact) => artifact.artifact_id === artifactId);
        const before = beforeArtifact ? await artifactContent(base, beforeArtifact) : "";
        const after = afterArtifact ? await artifactContent(target, afterArtifact) : "";
        sections.push(`## ${artifactById.get(artifactId)?.name ?? artifactId}\n${simpleLineDiff(before, after)}`);
      }
      setDiffText(sections.join("\n\n"));
    } catch (exc) {
      setError(String(exc));
    } finally {
      setDiffLoading(false);
    }
  }

  async function createWorkflow() {
    const created = await api.createWorkflow("New Workflow");
    setWorkflows((items) => [created, ...items]);
    const full = await loadWorkflow(created.id);
    setSelectedProcessId(full.processes[0]?.id ?? "");
    setSelectedArtifactId("");
  }

  const usage = totalUsage(selectedRun);
  const pendingQA = selectedRun?.qa.find((item) => item.status === "pending");
  const currentReview = selectedRun?.reviews[selectedRun.reviews.length - 1];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">DFD</span>
          <strong>Agent Process Orchestrator</strong>
        </div>
        <select
          value={workflow?.id ?? ""}
          onChange={async (event) => {
            const full = await loadWorkflow(event.target.value);
            setSelectedProcessId(full.processes[0]?.id ?? "");
            setSelectedArtifactId("");
          }}
        >
          {workflows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <input
          className="workflow-name"
          value={workflowNameDraft}
          onChange={(event) => setWorkflowNameDraft(event.target.value)}
          placeholder="Workflow name"
          title="Rename workflow"
        />
        <button className="icon-text" onClick={() => void createWorkflow()}>
          <Plus size={16} />
          Workflow
        </button>
        <div className="cost-strip">
          <span>{cost?.input_tokens ?? 0} in</span>
          <span>{cost?.output_tokens ?? 0} out</span>
          <strong>${(cost?.cost_usd ?? 0).toFixed(5)}</strong>
        </div>
      </header>

      {health?.active_adapter === "mock" && (
        <div className="warn-line">
          <span>
            Mock agent active (claude CLI not detected; runs complete instantly into review).
            Set ORCH_AGENT_MODE=claude and ensure `claude` is on PATH for real execution.
          </span>
        </div>
      )}

      {error && (
        <div className="error-line">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className="left-panel">
          <div className="panel-title">
            <strong>Processes</strong>
            <button className="icon-button" onClick={() => void addProcess()} title="Add process">
              <Plus size={16} />
            </button>
          </div>
          <div className="run-list">
            {(workflow?.processes ?? []).map((process) => (
              <button
                key={process.id}
                className={`run-row ${process.id === selectedProcessId ? "active" : ""}`}
                onClick={() => selectProcess(process.id)}
              >
                <span>{process.name}</span>
                <StatusPill status={process.runs[0]?.status} />
              </button>
            ))}
          </div>

          <div className="panel-title">
            <strong>Artifacts</strong>
            <div className="button-cluster">
              <button className="icon-button" onClick={() => void addArtifact("text")} title="Add text artifact">
                <Type size={15} />
              </button>
              <button className="icon-button" onClick={() => void addArtifact("file")} title="Add file artifact">
                <FileText size={15} />
              </button>
              <button className="icon-button" onClick={() => void addArtifact("url")} title="Add URL artifact">
                <Link size={15} />
              </button>
            </div>
          </div>
          <div className="run-list">
            {(workflow?.artifacts ?? []).map((artifact) => (
              <button
                key={artifact.id}
                className={`run-row ${artifact.id === selectedArtifactId ? "active" : ""}`}
                onClick={() => selectArtifact(artifact.id)}
              >
                <span>{artifact.name}</span>
                <ArtifactIcon type={artifact.type} />
              </button>
            ))}
          </div>

          <div className="panel-title">
            <strong>Runs</strong>
            <button
              className="icon-button"
              title="Refresh"
              onClick={() => workflow && void loadWorkflow(workflow.id)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="run-list">
            {(selectedProcess?.runs ?? []).map((run) => (
              <button
                key={run.id}
                className={`run-row ${run.id === selectedRun?.id ? "active" : ""}`}
                onClick={() => void api.getRun(run.id).then(setSelectedRun)}
              >
                <span>{run.id.slice(0, 12)}</span>
                <StatusPill status={run.status} />
              </button>
            ))}
          </div>
        </aside>

        <section className="canvas-panel">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgeDoubleClick={(_, edge) => {
              if (workflow) {
                void api.deleteEdge(edge.id).then(() => loadWorkflow(workflow.id));
              }
            }}
            onNodeDragStop={(_, node) =>
              void updateNodePosition(node.id, node.position.x, node.position.y)
            }
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </section>

        <aside className="right-panel">
          {processDraft && (
            <>
              <div className="panel-title">
                <strong>Process</strong>
                <div className="button-cluster">
                  <button className="icon-button" title="Run" onClick={() => void runProcess(processDraft.id)}>
                    <Play size={16} />
                  </button>
                  <button className="icon-button" title="Save" onClick={() => void saveProcess()}>
                    <Save size={16} />
                  </button>
                  <button className="icon-button danger" title="Delete" onClick={() => void deleteSelectedProcess()}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <label>
                Name
                <input value={processDraft.name} onChange={(event) => updateProcessDraft("name", event.target.value)} />
              </label>
              <div className="two-col">
                <label>
                  Type
                  <select value={processDraft.type} onChange={(event) => updateProcessDraft("type", event.target.value)}>
                    <option value="design">design</option>
                    <option value="implement">implement</option>
                    <option value="evaluate">evaluate</option>
                    <option value="review">review</option>
                  </select>
                </label>
                <label>
                  Agent
                  <select value={processDraft.agent_kind} onChange={(event) => updateProcessDraft("agent_kind", event.target.value)}>
                    <option value="claude">claude</option>
                  </select>
                </label>
              </div>
              <div className="two-col">
                <label>
                  Model
                  <select
                    value={processDraft.agent_model}
                    onChange={(event) => updateProcessDraft("agent_model", event.target.value)}
                  >
                    {!MODEL_OPTIONS.includes(processDraft.agent_model) && (
                      <option value={processDraft.agent_model}>{processDraft.agent_model}</option>
                    )}
                    {MODEL_OPTIONS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Effort
                  <select
                    value={processDraft.agent_effort || "medium"}
                    onChange={(event) => updateProcessDraft("agent_effort", event.target.value)}
                  >
                    {EFFORT_OPTIONS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="field-block">
                <span>Skills</span>
                <div className="skill-list">
                  {skills.length === 0 && <div className="muted-line">No skills found</div>}
                  {skills.map((skill) => {
                    const checked = processDraft.skills.some(
                      (item) => `${item.skill_source}:${item.skill_ref}` === skillKey(skill)
                    );
                    return (
                      <label className="skill-row" key={skillKey(skill)}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => toggleSkill(skill, event.target.checked)}
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small>{skill.skill_source}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="goal-box">
                <label>
                  Goal.md
                  <textarea
                    ref={goalRef}
                    value={processDraft.goal_md}
                    onChange={(event) => onGoalChange(event.target.value, event.target.selectionStart)}
                    onKeyUp={(event) => onGoalChange(event.currentTarget.value, event.currentTarget.selectionStart)}
                    rows={8}
                  />
                </label>
                {suggestOpen && (
                  <div className="suggest-list">
                    {goalArtifacts.map((artifact) => (
                      <button key={artifact.id} onClick={() => insertArtifactToken(artifact)}>
                        {artifact.name}
                      </button>
                    ))}
                    {goalArtifacts.length === 0 && <div className="muted-line">No connected artifacts</div>}
                  </div>
                )}
              </div>

              <details className="agents-base">
                <summary>AGENTS.md (base template, read-only)</summary>
                <pre className="readonly-pre">{agentsBase || "(empty)"}</pre>
              </details>

              <label>
                AGENTS.md Append
                <textarea
                  value={processDraft.agents_md_append}
                  onChange={(event) => updateProcessDraft("agents_md_append", event.target.value)}
                  rows={5}
                />
              </label>
            </>
          )}

          {artifactDraft && (
            <>
              <div className="panel-title">
                <strong>Artifact</strong>
                <div className="button-cluster">
                  <button className="icon-button" title="Save" onClick={() => void saveArtifact()}>
                    <Save size={16} />
                  </button>
                  <button className="icon-button danger" title="Delete" onClick={() => void deleteSelectedArtifact()}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <label>
                Name
                <input value={artifactDraft.name} onChange={(event) => updateArtifactDraft("name", event.target.value)} />
              </label>
              <label>
                Type
                <select value={artifactDraft.type} onChange={(event) => updateArtifactDraft("type", event.target.value as ArtifactType)}>
                  <option value="text">text</option>
                  <option value="file">file</option>
                  <option value="url">url</option>
                </select>
              </label>
              {artifactDraft.type === "text" && (
                <label>
                  Source Text
                  <textarea
                    value={artifactDraft.source_text ?? ""}
                    onChange={(event) => updateArtifactDraft("source_text", event.target.value)}
                    rows={7}
                  />
                </label>
              )}
              {artifactDraft.type === "url" && (
                <label>
                  Source URL
                  <input
                    value={artifactDraft.source_url ?? ""}
                    onChange={(event) => updateArtifactDraft("source_url", event.target.value)}
                  />
                </label>
              )}
              {artifactDraft.type === "file" && (
                <>
                  <label>
                    Source File Path
                    <input
                      value={artifactDraft.source_file_path ?? ""}
                      onChange={(event) => updateArtifactDraft("source_file_path", event.target.value)}
                    />
                  </label>
                  <label>
                    Expected Output Path
                    <input
                      value={artifactSpecText(artifactDraft, "path")}
                      onChange={(event) => updateArtifactSpec("path", event.target.value)}
                    />
                  </label>
                </>
              )}
            </>
          )}

          {!processDraft && !artifactDraft && <div className="empty-panel">Select a process or artifact</div>}
        </aside>
      </main>

      <section className="bottom-panel">
        <div className="activity-head">
          <div>
            <strong>{selectedRun ? selectedRun.id : "No run selected"}</strong>
            {selectedRun && <StatusPill status={selectedRun.status} />}
          </div>
          {selectedRun?.status === "failed" && (
            <button className="icon-text" onClick={() => void resumeSelectedRun()}>
              <Play size={15} />
              Resume
            </button>
          )}
          <div className="cost-strip">
            <span>{usage.input_tokens} in</span>
            <span>{usage.output_tokens} out</span>
            <strong>${usage.cost_usd.toFixed(5)}</strong>
          </div>
        </div>

        {selectedRun && (
          <div className="activity-grid">
            <div className="log-view">
              {selectedRun.logs.map((log) => (
                <div key={log.id} className={`log-line ${log.level}`}>
                  <time>{new Date(log.ts).toLocaleTimeString()}</time>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>

            <div className="review-panel">
              {pendingQA && (
                <div className="qa-block">
                  <div className="panel-title compact">
                    <strong>QA</strong>
                    <MessageSquare size={15} />
                  </div>
                  <p>{pendingQA.question_text}</p>
                  <textarea value={qaAnswer} onChange={(event) => setQaAnswer(event.target.value)} rows={3} />
                  <button className="icon-text" onClick={() => void answerQA()}>
                    <Check size={15} />
                    Answer
                  </button>
                </div>
              )}

              <div className="panel-title compact">
                <strong>Review</strong>
                {currentReview && <StatusPill status={currentReview.status} />}
              </div>
              <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} />
              <div className="button-row">
                <button className="icon-text" onClick={() => void review("approve")}>
                  <Check size={15} />
                  Approve
                </button>
                <button className="icon-text danger" onClick={() => void review("reject")}>
                  <X size={15} />
                  Reject
                </button>
              </div>

              <button className="link-button" onClick={() => setShowArtifacts((value) => !value)}>
                Artifacts
              </button>
              {showArtifacts && (
                <div className="artifact-list">
                  {selectedRun.artifacts.map((artifact) => {
                    const label = artifactById.get(artifact.artifact_id)?.name ?? artifact.artifact_id.slice(0, 12);
                    return (
                      <div key={artifact.id} className="artifact-row">
                        <span>{label}</span>
                        {artifact.artifact_type === "file" && (
                          <a href={artifactDownloadUrl(selectedRun.id, artifact.artifact_id)}>
                            {artifact.file_path}
                          </a>
                        )}
                        {artifact.artifact_type === "url" && <a href={artifact.url ?? ""}>{artifact.url}</a>}
                        {artifact.artifact_type === "text" && <textarea readOnly value={artifact.text_value ?? ""} rows={3} />}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="panel-title compact">
                <strong>Version Diff</strong>
              </div>
              <div className="diff-controls">
                <select value={diffBaseId} onChange={(event) => setDiffBaseId(event.target.value)}>
                  <option value="">Base run</option>
                  {(selectedProcess?.runs ?? []).map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.id.slice(0, 12)} ({run.status})
                    </option>
                  ))}
                </select>
                <select value={diffTargetId} onChange={(event) => setDiffTargetId(event.target.value)}>
                  <option value="">Target run</option>
                  {(selectedProcess?.runs ?? []).map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.id.slice(0, 12)} ({run.status})
                    </option>
                  ))}
                </select>
                <button className="icon-text" onClick={() => void loadRunDiff()} disabled={diffLoading}>
                  <RefreshCw size={15} />
                  Diff
                </button>
              </div>
              {diffText && <pre className="diff-view">{diffText}</pre>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
