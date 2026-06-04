import {
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  useReactFlow
} from "@xyflow/react";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "./api";
import { ActivityPanel } from "./components/ActivityPanel";
import { ArtifactInspector } from "./components/ArtifactInspector";
import { CanvasPanel, type CanvasNodeContextMenu } from "./components/CanvasPanel";
import type { FlowNodeData } from "./components/FlowNodes";
import { LeftPanel } from "./components/LeftPanel";
import { ProcessInspector } from "./components/ProcessInspector";
import { RunReviewPanel } from "./components/RunReviewPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Topbar } from "./components/Topbar";
import { useArtifactPreview } from "./hooks/useArtifactPreview";
import { useGoalAutocomplete } from "./hooks/useGoalAutocomplete";
import { useHealth } from "./hooks/useHealth";
import { useRunStream } from "./hooks/useRunStream";
import { useSkills } from "./hooks/useSkills";
import { artifactContent } from "./lib/artifactContent";
import { downloadJsonDocument, simpleLineDiff } from "./lib/format";
import { normalizeGoalForDisplay } from "./lib/goal";
import { artifactPayload, processPayload } from "./lib/payloads";
import { skillKey } from "./lib/skills";
import type {
  ArtifactNode,
  ArtifactType,
  CostSummary,
  ProcessNode,
  RunDetail,
  RunSummary,
  SkillCandidate,
  Workflow
} from "./types";

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

function artifactsConnectedToProcess(workflow: Workflow | null, processId: string): ArtifactNode[] {
  if (!workflow) {
    return [];
  }
  const connectedIds = new Set(
    workflow.edges.filter((edge) => edge.process_id === processId).map((edge) => edge.artifact_id)
  );
  return workflow.artifacts.filter((artifact) => connectedIds.has(artifact.id));
}

export function App() {
  const { fitView, screenToFlowPosition, setCenter } = useReactFlow();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>("");
  const [processDraft, setProcessDraft] = useState<ProcessNode | null>(null);
  const [artifactDraft, setArtifactDraft] = useState<ArtifactNode | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string>("");
  const [feedback, setFeedback] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [reviewExpanded, setReviewExpanded] = useState(true);
  const [diffBaseId, setDiffBaseId] = useState("");
  const [diffTargetId, setDiffTargetId] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [agentsBase, setAgentsBase] = useState("");
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>([]);
  const [expandedRunProcessIds, setExpandedRunProcessIds] = useState<Set<string>>(() => new Set());
  const [nodeContextMenu, setNodeContextMenu] = useState<CanvasNodeContextMenu>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const workflowImportRef = useRef<HTMLInputElement | null>(null);
  const workflowIdRef = useRef<string | null>(null);
  const savedProcessRef = useRef<string>("");
  const savedArtifactRef = useRef<string>("");
  const processSaveSeqRef = useRef(0);
  const artifactSaveSeqRef = useRef(0);
  const workflowSaveSeqRef = useRef(0);
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

  const selectProcess = useCallback(
    (id: string) => {
      setSelectedProcessId(id);
      setSelectedArtifactId("");
      centerFlowItem(id);
    },
    [centerFlowItem]
  );

  const selectArtifact = useCallback(
    (id: string) => {
      setSelectedArtifactId(id);
      setSelectedProcessId("");
      centerFlowItem(id);
    },
    [centerFlowItem]
  );

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

  const { health, refreshHealth } = useHealth();

  const {
    appSettings,
    expandedSkillKeys,
    loadInitialSkillState,
    openSettingsModal,
    refreshSkills,
    saveSettings,
    setSettingsDraft,
    setSettingsOpen,
    setSkillSearch,
    settingsDraft,
    settingsMessage,
    settingsOpen,
    settingsSaving,
    skillErrors,
    skillSearch,
    skills,
    toggleSkillDetails,
    visibleSkills
  } = useSkills({ processSkills: processDraft?.skills ?? [], setError });

  const { goalArtifacts, goalRef, insertArtifactToken, onGoalChange, suggestOpen } = useGoalAutocomplete({
    processDraft,
    setProcessDraft,
    workflow
  });

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
      await loadInitialSkillState();
      void refreshHealth();
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadInitialSkillState, loadWorkflow, refreshHealth]);

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
        ? (workflow?.edges.find((edge) => edge.kind === "produces" && edge.artifact_id === selectedArtifactId) ?? null)
        : null,
    [selectedArtifactId, workflow]
  );
  const selectedArtifactProducerName = useMemo(
    () =>
      selectedArtifactProducer
        ? (workflow?.processes.find((process) => process.id === selectedArtifactProducer.process_id)?.name ??
          "upstream process")
        : "",
    [selectedArtifactProducer, workflow]
  );

  const artifactById = useMemo(
    () => new Map((workflow?.artifacts ?? []).map((artifact) => [artifact.id, artifact])),
    [workflow]
  );

  useRunStream({
    selectedRun,
    setSelectedRun,
    setWorkflow,
    setCost,
    workflowIdRef,
    loadWorkflow,
    setError
  });

  const { artifactApprovedRun, artifactApprovedValue, artifactPreviewText, artifactPreviewLoading } =
    useArtifactPreview({
      workflow,
      selectedArtifactId,
      setError
    });

  const runProcess = useCallback(
    async (processId: string) => {
      const run = await api.runProcess(processId);
      setSelectedRun(run);
      const workflowId = workflowIdRef.current;
      if (workflowId) {
        await loadWorkflow(workflowId);
      }
    },
    [loadWorkflow]
  );

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
    api
      .getAgentsBase(selectedProcess.template_id || "base")
      .then((res) => setAgentsBase(res.content))
      .catch(() => setAgentsBase(""));
    const explicitRunId = explicitRunSelectionRef.current;
    const runToLoad = explicitRunId
      ? selectedProcess.runs?.find((run) => run.id === explicitRunId)
      : selectedProcess.runs?.[0];
    if (runToLoad) {
      explicitRunSelectionRef.current = "";
      void api
        .getRun(runToLoad.id)
        .then(setSelectedRun)
        .catch((exc) => setError(String(exc)));
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

  const selectedRunId = selectedRun?.id;
  const selectedRunStatus = selectedRun?.status;

  useEffect(() => {
    if (!selectedRunId) {
      reviewAutoCollapseKeyRef.current = "";
      setReviewExpanded(true);
      return;
    }
    const key = `${selectedRunId}:${selectedRunStatus}`;
    if (reviewAutoCollapseKeyRef.current === key) {
      return;
    }
    reviewAutoCollapseKeyRef.current = key;
    setReviewExpanded(selectedRunStatus !== "approved");
  }, [selectedRunId, selectedRunStatus]);

  const computedNodes = useMemo<Node<FlowNodeData>[]>(() => {
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
  }, [runProcess, selectArtifact, selectProcess, selectedArtifactId, selectedProcessId, workflow]);

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
      const existing = current.skills.filter((item) => `${item.skill_source}:${item.skill_ref}` !== skillKey(skill));
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
      const artifactIds = Array.from(
        new Set([
          ...base.artifacts.map((artifact) => artifact.artifact_id),
          ...target.artifacts.map((artifact) => artifact.artifact_id)
        ])
      );
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
      setSelectedArtifactId(full.processes.length === 0 ? (full.artifacts[0]?.id ?? "") : "");
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
        setSelectedArtifactId(full.processes.length === 0 ? (full.artifacts[0]?.id ?? "") : "");
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
      <Topbar
        workflowNameDraft={workflowNameDraft}
        cost={cost}
        onWorkflowNameChange={setWorkflowNameDraft}
        onOpenSettings={() => void openSettingsModal()}
      />

      {settingsOpen && (
        <SettingsModal
          settingsDraft={settingsDraft}
          settingsSaving={settingsSaving}
          settingsMessage={settingsMessage}
          skillErrors={skillErrors}
          skillCount={skills.length}
          appSettings={appSettings}
          onClose={() => setSettingsOpen(false)}
          onDraftChange={setSettingsDraft}
          onSave={() => void saveSettings()}
          onRefreshSkills={() => void refreshSkills()}
        />
      )}

      {health?.active_adapter === "mock" && (
        <div className="warn-line">
          <span>
            Mock agent active (claude CLI not detected; runs complete instantly into review). Set ORCH_AGENT_MODE=claude
            and ensure `claude` is on PATH for real execution.
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
          <LeftPanel
            workflows={workflows}
            workflow={workflow}
            workflowRunCost={workflowRunCost}
            workflowImportRef={workflowImportRef}
            runProcessSummaries={runProcessSummaries}
            expandedRunProcessIds={expandedRunProcessIds}
            selectedProcessId={selectedProcessId}
            selectedRunId={selectedRun?.id ?? null}
            onCreateWorkflow={() => void createWorkflow()}
            onExportWorkflow={() => void exportCurrentWorkflow()}
            onImportWorkflowFile={(file) => void importWorkflowFile(file)}
            onDeleteWorkflow={() => void deleteCurrentWorkflow()}
            onSelectWorkflow={(workflowId) => void selectWorkflow(workflowId)}
            onRefreshWorkflow={() => workflow && void loadWorkflow(workflow.id)}
            onSelectProcess={selectProcess}
            onToggleRunProcess={toggleRunProcess}
            onSelectRun={(processId, runId) => {
              explicitRunSelectionRef.current = runId;
              selectProcess(processId);
              void api
                .getRun(runId)
                .then(setSelectedRun)
                .catch((exc) => setError(String(exc)));
            }}
          />
        </Panel>

        <PanelResizeHandle className="resize-handle resize-h" />

        <Panel defaultSize={54} minSize={28} className="pg-panel">
          <PanelGroup direction="vertical" autoSaveId="orch-center">
            <Panel defaultSize={62} minSize={20} className="pg-panel">
              <CanvasPanel
                canvasRef={canvasRef}
                nodes={nodes}
                edges={edges}
                workflowExists={Boolean(workflow)}
                nodeContextMenu={nodeContextMenu}
                onNodesChange={onNodesChange}
                onConnect={onConnect}
                onClearContextMenu={() => setNodeContextMenu(null)}
                onSelectNode={(kind, id) => {
                  if (kind === "process") {
                    setSelectedProcessId(id);
                    setSelectedArtifactId("");
                  } else {
                    setSelectedArtifactId(id);
                    setSelectedProcessId("");
                  }
                }}
                onOpenContextMenu={setNodeContextMenu}
                onDeleteEdge={(edgeId) => {
                  if (workflow) {
                    void api.deleteEdge(edgeId).then(() => loadWorkflow(workflow.id));
                  }
                }}
                onUpdateNodePosition={(nodeId, x, y) => void updateNodePosition(nodeId, x, y)}
                onAddProcess={() => void addProcess()}
                onAddArtifact={(type) => void addArtifact(type)}
                onCopyNode={(kind, id) => void copyNode(kind, id)}
                onDeleteNode={(kind, id) => void deleteNode(kind, id)}
              />
            </Panel>

            <PanelResizeHandle className="resize-handle resize-v" />

            <Panel defaultSize={38} minSize={12} className="pg-panel">
              <ActivityPanel selectedRun={selectedRun} usage={usage} />
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-h" />

        <Panel defaultSize={26} minSize={15} className="pg-panel">
          <aside className="right-panel">
            <RunReviewPanel
              selectedRun={selectedRun}
              usage={usage}
              reviewExpanded={reviewExpanded}
              pendingQA={pendingQA}
              currentReview={currentReview}
              processRuns={selectedProcess?.runs ?? []}
              artifactById={artifactById}
              qaAnswer={qaAnswer}
              feedback={feedback}
              diffBaseId={diffBaseId}
              diffTargetId={diffTargetId}
              diffText={diffText}
              diffLoading={diffLoading}
              onToggleExpanded={() => setReviewExpanded((value) => !value)}
              onResumeRun={() => void resumeSelectedRun()}
              onQaAnswerChange={setQaAnswer}
              onAnswerQA={() => void answerQA()}
              onFeedbackChange={setFeedback}
              onReview={(action) => void review(action)}
              onDiffBaseChange={setDiffBaseId}
              onDiffTargetChange={setDiffTargetId}
              onLoadDiff={() => void loadRunDiff()}
            />

            <ProcessInspector
              processDraft={processDraft}
              health={health}
              skills={skills}
              visibleSkills={visibleSkills}
              skillSearch={skillSearch}
              expandedSkillKeys={expandedSkillKeys}
              goalRef={goalRef}
              suggestOpen={suggestOpen}
              goalArtifacts={goalArtifacts}
              agentsBase={agentsBase}
              onRun={() => processDraft && void runProcess(processDraft.id)}
              onSave={() => void saveProcess()}
              onDelete={() => void deleteSelectedProcess()}
              onUpdateDraft={updateProcessDraft}
              onSkillSearchChange={setSkillSearch}
              onToggleSkill={toggleSkill}
              onToggleSkillDetails={toggleSkillDetails}
              onGoalChange={onGoalChange}
              onInsertArtifactToken={insertArtifactToken}
            />

            <ArtifactInspector
              artifactDraft={artifactDraft}
              selectedArtifactProducer={selectedArtifactProducer}
              selectedArtifactProducerName={selectedArtifactProducerName}
              artifactApprovedRun={artifactApprovedRun}
              artifactApprovedValue={artifactApprovedValue}
              artifactPreviewText={artifactPreviewText}
              artifactPreviewLoading={artifactPreviewLoading}
              onSave={() => void saveArtifact()}
              onDelete={() => void deleteSelectedArtifact()}
              onUpdateDraft={updateArtifactDraft}
              onUploadSourceFile={(file) => void uploadArtifactSourceFile(file)}
            />

            {!selectedRun && !processDraft && !artifactDraft && (
              <div className="empty-panel">Select a process or artifact</div>
            )}
          </aside>
        </Panel>
      </PanelGroup>
    </div>
  );
}
