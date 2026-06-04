import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel as FlowPanel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  useReactFlow
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  Download,
  FileText,
  Link,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  Terminal,
  Trash2,
  Type,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api, artifactDownloadUrl, wsUrl } from "./api";
import { compactModelName, downloadJsonDocument, formatCost, simpleLineDiff, sourceFileName } from "./lib/format";
import { artifactDisplayLabel, normalizeGoalForDisplay } from "./lib/goal";
import { classifyLog, LOG_FILTERS, type ClassifiedLog, type LogCategory } from "./lib/logClassify";
import { artifactPayload, processPayload } from "./lib/payloads";
import { PERMISSION_MODES } from "./types";
import type {
  AppSettings,
  ArtifactNode,
  ArtifactType,
  ArtifactValue,
  CostSummary,
  HealthInfo,
  ProcessNode,
  RunDetail,
  RunLog,
  RunSummary,
  SkillCandidate,
  TokenUsage,
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

type NodeContextMenu = {
  id: string;
  kind: "process" | "artifact";
  x: number;
  y: number;
} | null;

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
  const skills = data.process.skills ?? [];
  const skillLabel =
    skills.length === 0
      ? "No skills"
      : skills.length === 1
        ? skills[0].skill_name
        : `${skills[0].skill_name} +${skills.length - 1}`;
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
        <span className="node-model" title={data.process.agent_model}>
          {compactModelName(data.process.agent_model)}
        </span>
        <span className="node-effort">{data.process.agent_effort || "medium"}</span>
        <StatusPill status={latest?.status} />
      </div>
      <div className="node-skills" title={skills.map((skill) => skill.skill_name).join(", ") || "No skills"}>
        {skillLabel}
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

function skillMatchesSearch(skill: SkillCandidate, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  const haystack = [
    skill.name,
    skill.description,
    skill.skill_source,
    skill.skill_ref,
    skill.path
  ].join("\n").toLowerCase();
  return trimmed.split(/\s+/).every((term) => haystack.includes(term));
}

function parseRepoDraft(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function artifactContent(run: Pick<RunDetail, "id">, artifact: ArtifactValue): Promise<string> {
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

const MODEL_OPTIONS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5"
];

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

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

function categoryIcon(category: LogCategory) {
  if (category === "agent") return <Bot size={14} />;
  if (category === "tool") return <Terminal size={14} />;
  if (category === "error") return <AlertTriangle size={14} />;
  return <SettingsIcon size={14} />;
}

function LogCard({ entry, showRaw }: { entry: ClassifiedLog; showRaw: boolean }) {
  const [open, setOpen] = useState(entry.isError);
  const hasBody = Boolean(entry.body && entry.body.trim()) || showRaw;
  return (
    <div className={`log-card ${entry.category}`}>
      <button className="log-card-head" onClick={() => hasBody && setOpen((v) => !v)}>
        <span className="log-cat">{categoryIcon(entry.category)}</span>
        <time>{new Date(entry.ts).toLocaleTimeString()}</time>
        <span className="log-title">{entry.title}</span>
        {hasBody && <span className="log-chevron">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>}
      </button>
      {open && hasBody && (
        <div className="log-body">
          {entry.body && entry.body.trim() && <pre>{entry.body}</pre>}
          {showRaw && <pre className="log-raw">{JSON.stringify(entry.raw, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function LogViewer({ logs, status }: { logs: RunLog[]; status: string }) {
  const [filter, setFilter] = useState<"all" | LogCategory>("all");
  const [query, setQuery] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const classified = useMemo(
    () => logs.map(classifyLog).filter((e): e is ClassifiedLog => e !== null),
    [logs]
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: classified.length, agent: 0, tool: 0, system: 0, error: 0 };
    for (const e of classified) c[e.category] += 1;
    return c;
  }, [classified]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return classified.filter((e) => {
      if (filter !== "all" && e.category !== filter) return false;
      if (q && !(e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [classified, filter, query]);

  const running = status === "running" || status === "waiting_qa" || status === "draft";
  const lastTool = useMemo(
    () => [...classified].reverse().find((e) => e.category === "tool" && e.tool !== "result"),
    [classified]
  );
  // 完了後は最後の Agent メッセージ（最終出力の要約）を上部に固定。
  const finished = status === "in_review" || status === "approved" || status === "rejected";
  const lastAgent = useMemo(
    () => [...classified].reverse().find((e) => e.category === "agent"),
    [classified]
  );

  // 自動スクロール：follow 中のみ最新へ。ユーザーが上にスクロールしたら停止。
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visible.length, follow]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  };

  return (
    <div className="log-viewer">
      {finished && lastAgent && (
        <div className="log-pinned">
          <span className="log-pinned-label">
            <Bot size={13} /> Final agent message
          </span>
          <pre>{lastAgent.body || lastAgent.title}</pre>
        </div>
      )}
      <div className="log-toolbar">
        <div className="log-filters">
          {LOG_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`log-filter ${filter === f.key ? "active" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="log-count">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="log-search">
          <Search size={13} />
          <input value={query} placeholder="Filter logs…" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <label className="log-raw-toggle">
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          Raw
        </label>
      </div>

      <div className="log-cards" ref={scrollRef} onScroll={onScroll}>
        {visible.length === 0 && <div className="muted-line">No log entries.</div>}
        {visible.map((entry) => (
          <LogCard key={entry.id} entry={entry} showRaw={showRaw} />
        ))}
      </div>

      <div className="log-footer">
        {running && (
          <span className="log-running">
            <span className="dot" /> {lastTool ? `Running ${lastTool.title}` : "Running…"}
          </span>
        )}
        {!follow && (
          <button className="log-jump" onClick={jumpToLatest}>
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const { fitView, screenToFlowPosition, setCenter } = useReactFlow();
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
  const [reviewExpanded, setReviewExpanded] = useState(true);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [diffBaseId, setDiffBaseId] = useState("");
  const [diffTargetId, setDiffTargetId] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [goalCursor, setGoalCursor] = useState(0);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [skillErrors, setSkillErrors] = useState<string[]>([]);
  const [agentsBase, setAgentsBase] = useState("");
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>([]);
  const [artifactApprovedRun, setArtifactApprovedRun] = useState<RunDetail | null>(null);
  const [artifactApprovedValue, setArtifactApprovedValue] = useState<ArtifactValue | null>(null);
  const [artifactPreviewText, setArtifactPreviewText] = useState("");
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [expandedRunProcessIds, setExpandedRunProcessIds] = useState<Set<string>>(() => new Set());
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenu>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [expandedSkillKeys, setExpandedSkillKeys] = useState<Set<string>>(() => new Set());
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const workflowImportRef = useRef<HTMLInputElement | null>(null);
  const workflowIdRef = useRef<string | null>(null);
  const savedProcessRef = useRef<string>("");
  const savedArtifactRef = useRef<string>("");
  const processSaveSeqRef = useRef(0);
  const artifactSaveSeqRef = useRef(0);
  const workflowSaveSeqRef = useRef(0);
  const artifactPreviewSeqRef = useRef(0);
  const fittedWorkflowRef = useRef("");
  const explicitRunSelectionRef = useRef("");
  const reviewAutoCollapseKeyRef = useRef("");
  const processSaveAbortRef = useRef<AbortController | null>(null);
  const artifactSaveAbortRef = useRef<AbortController | null>(null);
  const workflowSaveAbortRef = useRef<AbortController | null>(null);

  const loadWorkflow = useCallback(async (id: string) => {
    const data = await api.getWorkflow(id);
    setWorkflow(data);
    setCost(await api.workflowCost(id));
    return data;
  }, []);

  const centerFlowItem = useCallback(
    (id: string) => {
      const process = workflow?.processes.find((item) => item.id === id);
      const artifact = workflow?.artifacts.find((item) => item.id === id);
      if (!process && !artifact) {
        return;
      }
      const x = process ? process.pos_x + 125 : artifact!.pos_x + 110;
      const y = process ? process.pos_y + 54 : artifact!.pos_y + 48;
      window.requestAnimationFrame(() => {
        setCenter(x, y, { duration: 250 });
      });
    },
    [setCenter, workflow]
  );

  const nextCanvasPosition = useCallback(
    (kind: "process" | "artifact") => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 280, y: 180 };
      const count = (workflow?.processes.length ?? 0) + (workflow?.artifacts.length ?? 0);
      const stagger = (count % 6) * 24;
      const width = kind === "process" ? 250 : 220;
      const height = kind === "process" ? 108 : 96;
      return {
        x: Math.round(center.x - width / 2 + stagger),
        y: Math.round(center.y - height / 2 + stagger)
      };
    },
    [screenToFlowPosition, workflow?.artifacts.length, workflow?.processes.length]
  );

  const selectProcess = useCallback((id: string) => {
    setSelectedProcessId(id);
    setSelectedArtifactId("");
    centerFlowItem(id);
  }, [centerFlowItem]);

  const selectArtifact = useCallback((id: string) => {
    setSelectedArtifactId(id);
    setSelectedProcessId("");
    centerFlowItem(id);
  }, [centerFlowItem]);

  const toggleRunProcess = useCallback((processId: string) => {
    setExpandedRunProcessIds((current) => {
      const next = new Set(current);
      if (next.has(processId)) {
        next.delete(processId);
      } else {
        next.add(processId);
      }
      return next;
    });
  }, []);

  const toggleSkillDetails = useCallback((key: string) => {
    setExpandedSkillKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
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
      setSkillErrors(skillResponse.errors ?? []);
      const runtimeSettings = await api.getSettings();
      setAppSettings(runtimeSettings);
      setSettingsDraft(runtimeSettings.skill_repos.join("\n"));
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
  const selectedArtifactProducer = useMemo(
    () =>
      selectedArtifactId
        ? workflow?.edges.find((edge) => edge.kind === "produces" && edge.artifact_id === selectedArtifactId) ?? null
        : null,
    [selectedArtifactId, workflow]
  );
  const selectedArtifactProducerName = useMemo(
    () =>
      selectedArtifactProducer
        ? workflow?.processes.find((process) => process.id === selectedArtifactProducer.process_id)?.name ?? "upstream process"
        : "",
    [selectedArtifactProducer, workflow]
  );

  const artifactById = useMemo(
    () => new Map((workflow?.artifacts ?? []).map((artifact) => [artifact.id, artifact])),
    [workflow]
  );

  const visibleSkills = useMemo(() => {
    const selectedKeys = new Set(
      (processDraft?.skills ?? []).map((skill) => `${skill.skill_source}:${skill.skill_ref}`)
    );
    const selected: SkillCandidate[] = [];
    const unselected: SkillCandidate[] = [];
    for (const skill of skills) {
      const isSelected = selectedKeys.has(skillKey(skill));
      if (isSelected) {
        selected.push(skill);
      } else if (skillMatchesSearch(skill, skillSearch)) {
        unselected.push(skill);
      }
    }
    return [...selected, ...unselected];
  }, [processDraft?.skills, skillSearch, skills]);

  // 選択した工程が「変わったとき」だけドラフトを読み込む（id をキーに）。
  // workflow の再取得（autosave/コストポーリング）では再読込しないので入力中も消えない。
  useEffect(() => {
    if (!selectedProcessId) {
      setProcessDraft(null);
      savedProcessRef.current = "";
      setAgentsBase("");
      setSelectedRun(null);
      return;
    }
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
    const explicitRunId = explicitRunSelectionRef.current;
    const runToLoad = explicitRunId
      ? selectedProcess.runs?.find((run) => run.id === explicitRunId)
      : selectedProcess.runs?.[0];
    if (runToLoad) {
      explicitRunSelectionRef.current = "";
      void api.getRun(runToLoad.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
    } else {
      setSelectedRun(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProcessId, selectedProcess?.id]);

  useEffect(() => {
    if (!selectedArtifactId) {
      setArtifactDraft(null);
      savedArtifactRef.current = "";
      return;
    }
    if (!selectedArtifact) {
      setArtifactDraft(null);
      savedArtifactRef.current = "";
      return;
    }
    const draft = structuredClone(selectedArtifact);
    setArtifactDraft(draft);
    savedArtifactRef.current = JSON.stringify(artifactPayload(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId, selectedArtifact?.id]);

  useEffect(() => {
    const seq = ++artifactPreviewSeqRef.current;
    setArtifactApprovedRun(null);
    setArtifactApprovedValue(null);
    setArtifactPreviewText("");
    setArtifactPreviewLoading(false);

    if (!workflow || !selectedArtifactId) {
      return;
    }
    const producerEdge = workflow.edges.find(
      (edge) => edge.kind === "produces" && edge.artifact_id === selectedArtifactId
    );
    const producer = producerEdge
      ? workflow.processes.find((process) => process.id === producerEdge.process_id)
      : null;
    const approvedRun = producer?.runs.find((run) => run.status === "approved");
    if (!approvedRun) {
      return;
    }

    setArtifactPreviewLoading(true);
    void api
      .getRun(approvedRun.id)
      .then(async (run) => {
        if (seq !== artifactPreviewSeqRef.current) {
          return;
        }
        const value = run.artifacts.find((artifact) => artifact.artifact_id === selectedArtifactId) ?? null;
        setArtifactApprovedRun(run);
        setArtifactApprovedValue(value);
        if (!value) {
          setArtifactPreviewText("");
          return;
        }
        const content = await artifactContent(run, value);
        if (seq === artifactPreviewSeqRef.current) {
          setArtifactPreviewText(content);
        }
      })
      .catch((exc) => {
        if (seq === artifactPreviewSeqRef.current) {
          setError(String(exc));
        }
      })
      .finally(() => {
        if (seq === artifactPreviewSeqRef.current) {
          setArtifactPreviewLoading(false);
        }
      });
  }, [selectedArtifactId, workflow]);

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
    if (!selectedRun) {
      reviewAutoCollapseKeyRef.current = "";
      setReviewExpanded(true);
      return;
    }
    const key = `${selectedRun.id}:${selectedRun.status}`;
    if (reviewAutoCollapseKeyRef.current === key) {
      return;
    }
    reviewAutoCollapseKeyRef.current = key;
    setReviewExpanded(selectedRun.status !== "approved");
  }, [selectedRun?.id, selectedRun?.status]);

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
        const usageEvent = event.payload as unknown as TokenUsage;
        setSelectedRun((current) =>
          current && current.id === selectedRun.id
            ? {
                ...current,
                token_usage: appendUnique(
                  current.token_usage,
                  usageEvent
                )
              }
            : current
        );
        setWorkflow((current) =>
          current
            ? {
                ...current,
                processes: current.processes.map((process) => ({
                  ...process,
                  runs: process.runs.map((run) =>
                    run.id === usageEvent.run_id
                      ? {
                          ...run,
                          input_tokens: (run.input_tokens ?? 0) + usageEvent.input_tokens,
                          output_tokens: (run.output_tokens ?? 0) + usageEvent.output_tokens,
                          cache_read: (run.cache_read ?? 0) + usageEvent.cache_read,
                          cache_write: (run.cache_write ?? 0) + usageEvent.cache_write,
                          cost_usd: (run.cost_usd ?? 0) + usageEvent.cost_usd
                        }
                      : run
                  )
                }))
              }
            : current
        );
        setCost((current) =>
          current
            ? {
                input_tokens: current.input_tokens + usageEvent.input_tokens,
                output_tokens: current.output_tokens + usageEvent.output_tokens,
                cache_read: current.cache_read + usageEvent.cache_read,
                cache_write: current.cache_write + usageEvent.cache_write,
                cost_usd: current.cost_usd + usageEvent.cost_usd
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

  useEffect(() => {
    if (!workflow?.id || nodes.length === 0 || fittedWorkflowRef.current === workflow.id) {
      return;
    }
    fittedWorkflowRef.current = workflow.id;
    const frame = window.requestAnimationFrame(() => {
      fitView({ padding: 0.25, duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, nodes.length, workflow?.id]);

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

  async function selectWorkflow(workflowId: string) {
    if (!workflowId) {
      return;
    }
    const full = await loadWorkflow(workflowId);
    setSelectedProcessId(full.processes[0]?.id ?? "");
    setSelectedArtifactId("");
  }

  async function addProcess() {
    if (!workflow) {
      return;
    }
    const position = nextCanvasPosition("process");
    const created = await api.createProcess(workflow.id, {
      name: `Process ${workflow.processes.length + 1}`,
      pos_x: position.x,
      pos_y: position.y
    });
    await loadWorkflow(workflow.id);
    selectProcess(created.id);
  }

  async function addArtifact(type: ArtifactType = "text") {
    if (!workflow) {
      return;
    }
    const position = nextCanvasPosition("artifact");
    const created = await api.createArtifact(workflow.id, {
      name: `Artifact ${workflow.artifacts.length + 1}`,
      type,
      pos_x: position.x,
      pos_y: position.y
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

  async function uploadArtifactSourceFile(file: File | null) {
    if (!file || !artifactDraft || artifactDraft.type !== "file" || selectedArtifactProducer) {
      return;
    }
    try {
      const updated = await api.uploadArtifactSourceFile(artifactDraft.id, file);
      setArtifactDraft(updated);
      savedArtifactRef.current = JSON.stringify(artifactPayload(updated));
      if (workflow) {
        await loadWorkflow(workflow.id);
      }
    } catch (exc) {
      setError(String(exc));
    }
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
    await deleteNode("process", processDraft.id);
  }

  async function deleteSelectedArtifact() {
    if (!artifactDraft || !workflow) {
      return;
    }
    await deleteNode("artifact", artifactDraft.id);
  }

  async function copyNode(kind: "process" | "artifact", id: string) {
    if (!workflow) {
      return;
    }
    setNodeContextMenu(null);
    if (kind === "process") {
      const source = workflow.processes.find((process) => process.id === id);
      if (!source) {
        return;
      }
      const created = await api.createProcess(workflow.id, {
        name: `${source.name} copy`,
        pos_x: source.pos_x + 36,
        pos_y: source.pos_y + 36
      });
      await api.updateProcessConfig(created.id, {
        ...processPayload(source, artifactsConnectedToProcess(workflow, source.id)),
        name: `${source.name} copy`
      });
      await loadWorkflow(workflow.id);
      setSelectedArtifactId("");
      setSelectedProcessId(created.id);
      return;
    }

    const source = workflow.artifacts.find((artifact) => artifact.id === id);
    if (!source) {
      return;
    }
    const created = await api.createArtifact(workflow.id, {
      name: `${source.name} copy`,
      type: source.type,
      pos_x: source.pos_x + 36,
      pos_y: source.pos_y + 36
    });
    await api.updateArtifact(created.id, {
      name: `${source.name} copy`,
      type: source.type,
      source_text: source.source_text,
      source_url: source.source_url,
      source_file_path: source.source_file_path,
      spec_json: source.spec_json
    });
    await loadWorkflow(workflow.id);
    setSelectedProcessId("");
    setSelectedArtifactId(created.id);
  }

  async function deleteNode(kind: "process" | "artifact", id: string) {
    if (!workflow) {
      return;
    }
    setNodeContextMenu(null);
    if (kind === "process") {
      await api.deleteProcess(id);
      if (selectedProcessId === id) {
        setSelectedProcessId("");
        setProcessDraft(null);
        setSelectedRun(null);
      }
    } else {
      await api.deleteArtifact(id);
      if (selectedArtifactId === id) {
        setSelectedArtifactId("");
        setArtifactDraft(null);
      }
    }
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

  async function openSettingsModal() {
    setSettingsOpen(true);
    setSettingsMessage("");
    try {
      const runtimeSettings = await api.getSettings();
      setAppSettings(runtimeSettings);
      setSettingsDraft(runtimeSettings.skill_repos.join("\n"));
    } catch (exc) {
      setError(String(exc));
    }
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setSettingsMessage("");
    try {
      const updated = await api.updateSettings({ skill_repos: parseRepoDraft(settingsDraft) });
      setAppSettings(updated);
      setSettingsDraft(updated.skill_repos.join("\n"));
      const skillResponse = await api.listSkills(true);
      setSkills(skillResponse.skills);
      setSkillErrors(skillResponse.errors ?? []);
      setSettingsMessage(`${skillResponse.skills.length} skills available.`);
    } catch (exc) {
      setError(String(exc));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function refreshSkills() {
    setSettingsSaving(true);
    setSettingsMessage("");
    try {
      const skillResponse = await api.listSkills(true);
      setSkills(skillResponse.skills);
      setSkillErrors(skillResponse.errors ?? []);
      setSettingsMessage(`${skillResponse.skills.length} skills available.`);
    } catch (exc) {
      setError(String(exc));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function createWorkflow() {
    const created = await api.createWorkflow("New Workflow");
    setWorkflows((items) => [created, ...items]);
    const full = await loadWorkflow(created.id);
    setSelectedProcessId(full.processes[0]?.id ?? "");
    setSelectedArtifactId("");
  }

  async function exportCurrentWorkflow() {
    if (!workflow) {
      return;
    }
    try {
      const { document, filename } = await api.exportWorkflow(workflow.id);
      downloadJsonDocument(document, filename);
    } catch (exc) {
      setError(String(exc));
    }
  }

  async function importWorkflowFile(file: File | null) {
    if (!file) {
      return;
    }
    try {
      const document = JSON.parse(await file.text());
      const created = await api.importWorkflow(document);
      setWorkflows(await api.listWorkflows());
      const full = await loadWorkflow(created.id);
      setSelectedProcessId(full.processes[0]?.id ?? "");
      setSelectedArtifactId(full.processes.length === 0 ? full.artifacts[0]?.id ?? "" : "");
    } catch (exc) {
      setError(String(exc));
    } finally {
      if (workflowImportRef.current) {
        workflowImportRef.current.value = "";
      }
    }
  }

  async function deleteCurrentWorkflow() {
    if (!workflow) {
      return;
    }
    const confirmed = window.confirm(`Delete workflow "${workflow.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    try {
      await api.deleteWorkflow(workflow.id);
      const list = await api.listWorkflows();
      setWorkflows(list);
      setSelectedRun(null);
      setSelectedProcessId("");
      setSelectedArtifactId("");
      setProcessDraft(null);
      setArtifactDraft(null);
      if (list.length > 0) {
        const full = await loadWorkflow(list[0].id);
        setSelectedProcessId(full.processes[0]?.id ?? "");
        setSelectedArtifactId(full.processes.length === 0 ? full.artifacts[0]?.id ?? "" : "");
      } else {
        setWorkflow(null);
        setCost(null);
        setWorkflowNameDraft("");
      }
    } catch (exc) {
      setError(String(exc));
    }
  }

  const usage = totalUsage(selectedRun);
  const pendingQA = selectedRun?.qa.find((item) => item.status === "pending");
  const currentReview = selectedRun?.reviews[selectedRun.reviews.length - 1];
  const runProcessSummaries = useMemo(
    () =>
      (workflow?.processes ?? []).map((process) => {
        const runs = [...process.runs].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
        const latestRun: RunSummary | undefined = runs[0];
        const totalCost = runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);
        return { process, runs, latestRun, totalCost };
      }),
    [workflow]
  );
  const workflowRunCost = useMemo(
    () => runProcessSummaries.reduce((sum, item) => sum + item.totalCost, 0),
    [runProcessSummaries]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">DFD</span>
          <strong>Agent Process Orchestrator</strong>
        </div>
        <input
          className="workflow-name"
          value={workflowNameDraft}
          onChange={(event) => setWorkflowNameDraft(event.target.value)}
          placeholder="Workflow name"
          title="Rename workflow"
        />
        <div className="cost-strip">
          <span>{cost?.input_tokens ?? 0} in</span>
          <span>{cost?.output_tokens ?? 0} out</span>
          <strong>${(cost?.cost_usd ?? 0).toFixed(5)}</strong>
        </div>
        <button className="icon-button" title="Settings" onClick={() => void openSettingsModal()}>
          <SettingsIcon size={16} />
        </button>
      </header>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="panel-title">
              <strong id="settings-title">Settings</strong>
              <button className="icon-button" title="Close" onClick={() => setSettingsOpen(false)}>
                <X size={15} />
              </button>
            </div>

            <div className="field-block">
              <span>Skill Repositories</span>
              <textarea
                value={settingsDraft}
                onChange={(event) => setSettingsDraft(event.target.value)}
                rows={7}
                placeholder={"owner/repo\nowner/repo@main\n/home/user/local-skills"}
              />
              <small className="muted-line">
                One repository per line. Local paths are allowed. GitHub repositories use gh and are cached under config.
              </small>
            </div>

            <div className="settings-facts">
              <span>Current skills</span>
              <strong>{skills.length}</strong>
              <span>Config root</span>
              <code>{appSettings?.config_root ?? ""}</code>
              <span>Skill cache</span>
              <code>{appSettings?.skill_cache_root ?? ""}</code>
            </div>

            {skillErrors.length > 0 && (
              <div className="settings-errors">
                {skillErrors.map((item) => (
                  <div key={item}>{item}</div>
                ))}
              </div>
            )}
            {settingsMessage && <div className="muted-line">{settingsMessage}</div>}

            <div className="button-row">
              <button className="icon-text" disabled={settingsSaving} onClick={() => void saveSettings()}>
                <Save size={15} />
                Save
              </button>
              <button className="icon-text" disabled={settingsSaving} onClick={() => void refreshSkills()}>
                <RefreshCw size={15} />
                Refresh Skills
              </button>
            </div>
          </section>
        </div>
      )}

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

      <PanelGroup direction="horizontal" className="workspace-pg" autoSaveId="orch-cols">
        <Panel defaultSize={20} minSize={12} className="pg-panel">
        <aside className="left-panel">
          <div className="panel-title">
            <strong>Workflows</strong>
            <div className="button-cluster">
              <button className="icon-button" onClick={() => void createWorkflow()} title="Add workflow">
                <Plus size={16} />
              </button>
              <button className="icon-button" onClick={() => void exportCurrentWorkflow()} title="Export workflow" disabled={!workflow}>
                <Download size={16} />
              </button>
              <button className="icon-button" onClick={() => workflowImportRef.current?.click()} title="Import workflow">
                <Upload size={16} />
              </button>
              <button className="icon-button danger" onClick={() => void deleteCurrentWorkflow()} title="Delete workflow" disabled={!workflow}>
                <Trash2 size={16} />
              </button>
            </div>
            <input
              ref={workflowImportRef}
              className="hidden-file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => void importWorkflowFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="run-list">
            {workflows.map((item) => (
              <button
                key={item.id}
                className={`run-row ${item.id === workflow?.id ? "active" : ""}`}
                onClick={() => void selectWorkflow(item.id)}
              >
                <span className="run-main">
                  <span>{item.name}</span>
                  <small>{item.id.slice(0, 12)}</small>
                </span>
              </button>
            ))}
            {workflows.length === 0 && <div className="muted-line">No workflows yet</div>}
          </div>

          <div className="panel-title">
            <strong>Runs</strong>
            <span className="run-total">{formatCost(workflowRunCost)}</span>
            <button
              className="icon-button"
              title="Refresh"
              onClick={() => workflow && void loadWorkflow(workflow.id)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="run-list">
            {runProcessSummaries.map(({ process, runs, latestRun, totalCost }) => {
              const expanded = expandedRunProcessIds.has(process.id);
              return (
                <div className="run-group" key={process.id}>
                  <button
                    className={`run-row run-group-row ${process.id === selectedProcessId ? "active" : ""}`}
                    onClick={() => {
                      selectProcess(process.id);
                      toggleRunProcess(process.id);
                    }}
                  >
                    <span className="run-main">
                      <span>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {process.name}
                      </span>
                      <small>{runs.length} runs</small>
                    </span>
                    <span className="run-side">
                      <span className="run-cost">{formatCost(totalCost)}</span>
                      <StatusPill status={latestRun?.status} />
                    </span>
                  </button>
                  {expanded && (
                    <div className="run-children">
                      {runs.map((run) => (
                        <button
                          key={run.id}
                          className={`run-row run-child-row ${run.id === selectedRun?.id ? "active" : ""}`}
                          onClick={() => {
                            explicitRunSelectionRef.current = run.id;
                            selectProcess(process.id);
                            void api.getRun(run.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
                          }}
                        >
                          <span className="run-main">
                            <span>{run.id.slice(0, 12)}</span>
                            <small>{new Date(run.started_at).toLocaleString()}</small>
                          </span>
                          <span className="run-side">
                            <span className="run-cost">{formatCost(run.cost_usd)}</span>
                            <StatusPill status={run.status} />
                          </span>
                        </button>
                      ))}
                      {runs.length === 0 && <div className="muted-line run-empty">No runs yet</div>}
                    </div>
                  )}
                </div>
              );
            })}
            {runProcessSummaries.length === 0 && <div className="muted-line">No processes yet</div>}
          </div>
        </aside>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-h" />

        <Panel defaultSize={54} minSize={28} className="pg-panel">
        <PanelGroup direction="vertical" autoSaveId="orch-center">
        <Panel defaultSize={62} minSize={20} className="pg-panel">
        <section className="canvas-panel" ref={canvasRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onPaneClick={() => setNodeContextMenu(null)}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              const kind = node.type === "artifact" ? "artifact" : "process";
              if (kind === "process") {
                setSelectedProcessId(node.id);
                setSelectedArtifactId("");
              } else {
                setSelectedArtifactId(node.id);
                setSelectedProcessId("");
              }
              setNodeContextMenu({
                id: node.id,
                kind,
                x: Math.min(event.clientX, window.innerWidth - 180),
                y: Math.min(event.clientY, window.innerHeight - 96)
              });
            }}
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
            <FlowPanel position="top-left" className="canvas-toolbar">
              <button className="icon-text" onClick={() => void addProcess()} disabled={!workflow}>
                <Plus size={15} />
                Process
              </button>
              <button className="icon-text" onClick={() => void addArtifact("text")} disabled={!workflow}>
                <Type size={15} />
                Text
              </button>
              <button className="icon-text" onClick={() => void addArtifact("file")} disabled={!workflow}>
                <FileText size={15} />
                File
              </button>
              <button className="icon-text" onClick={() => void addArtifact("url")} disabled={!workflow}>
                <Link size={15} />
                URL
              </button>
            </FlowPanel>
            <Background />
            <Controls />
          </ReactFlow>
          {nodeContextMenu && (
            <div
              className="node-context-menu"
              style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button onClick={() => void copyNode(nodeContextMenu.kind, nodeContextMenu.id)}>
                <Copy size={14} />
                Copy
              </button>
              <button
                className="danger"
                onClick={() => void deleteNode(nodeContextMenu.kind, nodeContextMenu.id)}
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          )}
        </section>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-v" />

        <Panel defaultSize={38} minSize={12} className="pg-panel">
        <section className="bottom-panel">
          <div className="activity-head">
            <div>
              <strong>{selectedRun ? selectedRun.id : "No run selected"}</strong>
              {selectedRun && <StatusPill status={selectedRun.status} />}
            </div>
            <div className="cost-strip">
              <span>{usage.input_tokens} in</span>
              <span>{usage.output_tokens} out</span>
              <strong>{formatCost(usage.cost_usd)}</strong>
            </div>
          </div>

          {selectedRun && (
            <div className="activity-grid log-only">
              <LogViewer key={selectedRun.id} logs={selectedRun.logs} status={selectedRun.status} />
            </div>
          )}
        </section>
        </Panel>
        </PanelGroup>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-h" />

        <Panel defaultSize={26} minSize={15} className="pg-panel">
        <aside className="right-panel">
          {selectedRun && (
            <div className="review-panel embedded-review">
              <div className="panel-title">
                <strong>Run Review</strong>
                <div className="button-cluster">
                  <StatusPill status={selectedRun.status} />
                  <button
                    className="icon-button"
                    title={reviewExpanded ? "Collapse review" : "Expand review"}
                    onClick={() => setReviewExpanded((value) => !value)}
                  >
                    {reviewExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                </div>
              </div>
              <div className="run-review-meta">
                <span>{selectedRun.id.slice(0, 12)}</span>
                <span>{usage.input_tokens} in</span>
                <span>{usage.output_tokens} out</span>
                <strong>{formatCost(usage.cost_usd)}</strong>
              </div>

              {reviewExpanded && (
                <>
                  {selectedRun.status === "failed" && (
                    <button className="icon-text" onClick={() => void resumeSelectedRun()}>
                      <Play size={15} />
                      Resume
                    </button>
                  )}

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
                    <button
                      className="icon-text"
                      onClick={() => void review("approve")}
                      disabled={selectedRun.status !== "in_review"}
                    >
                      <Check size={15} />
                      Approve
                    </button>
                    <button
                      className="icon-text danger"
                      onClick={() => void review("reject")}
                      disabled={selectedRun.status !== "in_review"}
                    >
                      <X size={15} />
                      Reject
                    </button>
                  </div>

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
                </>
              )}

              <div className="panel-title compact">
                <strong>Artifacts</strong>
                <span className="muted-line">{selectedRun.artifacts.length}</span>
              </div>
              {selectedRun.artifacts.length === 0 && <div className="muted-line">No artifacts submitted.</div>}
              {selectedRun.artifacts.length > 0 && (
                <div className="artifact-list">
                  {selectedRun.artifacts.map((artifact) => {
                    const label = artifactById.get(artifact.artifact_id)?.name ?? artifact.artifact_id.slice(0, 12);
                    return (
                      <div key={artifact.id} className="artifact-row">
                        <span>{label}</span>
                        {artifact.artifact_type === "file" && (
                          <a
                            href={artifactDownloadUrl(selectedRun.id, artifact.artifact_id)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {artifact.file_path}
                          </a>
                        )}
                        {artifact.artifact_type === "url" && (
                          <a href={artifact.url ?? ""} target="_blank" rel="noreferrer">
                            {artifact.url}
                          </a>
                        )}
                        {artifact.artifact_type === "text" && <textarea readOnly value={artifact.text_value ?? ""} rows={3} />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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
                  Agent
                  <select value={processDraft.agent_kind} onChange={(event) => updateProcessDraft("agent_kind", event.target.value)}>
                    <option value="claude">claude</option>
                  </select>
                </label>
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
              </div>
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

              <div className="field-block">
                <span>Permissions</span>
                <label>
                  Mode
                  <select
                    value={processDraft.permission_mode}
                    onChange={(event) => updateProcessDraft("permission_mode", event.target.value)}
                  >
                    <option value="">inherit ({health?.default_permission_mode ?? "default"})</option>
                    {PERMISSION_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Allowed tools (comma-separated)
                  <input
                    value={processDraft.allowed_tools}
                    placeholder={health?.default_allowed_tools ?? ""}
                    onChange={(event) => updateProcessDraft("allowed_tools", event.target.value)}
                  />
                </label>
                <label>
                  Disallowed tools
                  <input
                    value={processDraft.disallowed_tools}
                    placeholder={health?.default_disallowed_tools || "(none)"}
                    onChange={(event) => updateProcessDraft("disallowed_tools", event.target.value)}
                  />
                </label>
                <small className="muted-line">
                  Empty = inherit global default. Submission runs utils/submit.py via Bash, so the
                  effective permissions must allow it (the default allowlist covers python; or use
                  bypassPermissions).
                </small>
              </div>

              <div className="field-block">
                <span>Skills</span>
                <div className="skill-search">
                  <Search size={14} />
                  <input
                    aria-label="Search skills"
                    value={skillSearch}
                    placeholder="Search skills"
                    onChange={(event) => setSkillSearch(event.target.value)}
                  />
                </div>
                <div className="skill-count">
                  {visibleSkills.length} / {skills.length} shown
                  {processDraft.skills.length > 0 ? `, ${processDraft.skills.length} selected` : ""}
                </div>
                <div className="skill-list">
                  {skills.length === 0 && <div className="muted-line">No skills found</div>}
                  {skills.length > 0 && visibleSkills.length === 0 && (
                    <div className="muted-line">No matching skills</div>
                  )}
                  {visibleSkills.map((skill) => {
                    const key = skillKey(skill);
                    const expanded = expandedSkillKeys.has(key);
                    const checked = processDraft.skills.some(
                      (item) => `${item.skill_source}:${item.skill_ref}` === key
                    );
                    return (
                      <div className={`skill-card ${checked ? "selected" : ""}`} key={key}>
                        <div className="skill-row">
                          <label className="skill-check">
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
                          <button
                            className="icon-button skill-expand"
                            title={expanded ? "Hide skill details" : "Show skill details"}
                            onClick={() => toggleSkillDetails(key)}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </div>
                        {expanded && (
                          <div className="skill-detail">
                            <p>{skill.description || "No description."}</p>
                            <div className="skill-detail-grid">
                              <span>Ref</span>
                              <code>{skill.skill_ref}</code>
                              <span>Path</span>
                              <code>{skill.path}</code>
                            </div>
                          </div>
                        )}
                      </div>
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
              {selectedArtifactProducer && (
                <div className="field-block generated-source-note">
                  <span>Source</span>
                  <div className="muted-line">
                    Generated by {selectedArtifactProducerName}. User source input is disabled.
                  </div>
                </div>
              )}
              {!selectedArtifactProducer && artifactDraft.type === "text" && (
                <label>
                  Source Text
                  <textarea
                    value={artifactDraft.source_text ?? ""}
                    onChange={(event) => updateArtifactDraft("source_text", event.target.value)}
                    rows={7}
                  />
                </label>
              )}
              {!selectedArtifactProducer && artifactDraft.type === "url" && (
                <label>
                  Source URL
                  <input
                    value={artifactDraft.source_url ?? ""}
                    onChange={(event) => updateArtifactDraft("source_url", event.target.value)}
                  />
                </label>
              )}
              {!selectedArtifactProducer && artifactDraft.type === "file" && (
                <div className="field-block">
                  <span>Source File</span>
                  <input
                    type="file"
                    onChange={(event) => void uploadArtifactSourceFile(event.target.files?.[0] ?? null)}
                  />
                  {artifactDraft.source_file_path ? (
                    <div className="muted-line">Uploaded: {sourceFileName(artifactDraft.source_file_path)}</div>
                  ) : (
                    <div className="muted-line">No file uploaded.</div>
                  )}
                </div>
              )}
              <div className="field-block">
                <span>Latest Approved Output</span>
                {!artifactApprovedRun && !artifactPreviewLoading && (
                  <div className="muted-line">No approved output for this artifact yet.</div>
                )}
                {artifactPreviewLoading && <div className="muted-line">Loading approved output...</div>}
                {artifactApprovedRun && (
                  <div className="artifact-row">
                    <span>
                      {artifactApprovedRun.id.slice(0, 12)} ({artifactApprovedRun.status})
                    </span>
                    {artifactApprovedValue?.artifact_type === "file" && (
                      <a
                        href={artifactDownloadUrl(artifactApprovedRun.id, artifactApprovedValue.artifact_id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {artifactApprovedValue.file_path}
                      </a>
                    )}
                    {artifactApprovedValue?.artifact_type === "url" && (
                      <a href={artifactApprovedValue.url ?? ""} target="_blank" rel="noreferrer">
                        {artifactApprovedValue.url}
                      </a>
                    )}
                    {artifactApprovedValue?.artifact_type === "text" && (
                      <textarea readOnly value={artifactPreviewText} rows={7} />
                    )}
                    {artifactApprovedValue?.artifact_type === "file" && (
                      <textarea readOnly value={artifactPreviewText} rows={7} />
                    )}
                    {!artifactApprovedValue && <div className="muted-line">The approved run has no value for this artifact.</div>}
                  </div>
                )}
              </div>
            </>
          )}

          {!selectedRun && !processDraft && !artifactDraft && <div className="empty-panel">Select a process or artifact</div>}
        </aside>
        </Panel>
      </PanelGroup>
    </div>
  );
}
