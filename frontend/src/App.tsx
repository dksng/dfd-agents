import { type Connection, useReactFlow } from "@xyflow/react";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "./api";
import { ActivityPanel } from "./components/ActivityPanel";
import { ArtifactInspector } from "./components/ArtifactInspector";
import { CanvasPanel, type CanvasNodeContextMenu } from "./components/CanvasPanel";
import { LeftPanel } from "./components/LeftPanel";
import { ProcessInspector } from "./components/ProcessInspector";
import { RunReviewPanel } from "./components/RunReviewPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Topbar } from "./components/Topbar";
import { useArtifactPreview } from "./hooks/useArtifactPreview";
import { useDrafts } from "./hooks/useDrafts";
import { useFlowGraph } from "./hooks/useFlowGraph";
import { useGoalAutocomplete } from "./hooks/useGoalAutocomplete";
import { useHealth } from "./hooks/useHealth";
import { useRunReview } from "./hooks/useRunReview";
import { useRunStream } from "./hooks/useRunStream";
import { useSkills } from "./hooks/useSkills";
import { useWorkflowActions } from "./hooks/useWorkflowActions";
import { useWorkflowName } from "./hooks/useWorkflowName";
import { processPayload } from "./lib/payloads";
import { artifactsConnectedToProcess } from "./lib/workflow";
import type { ArtifactType, CostSummary, RunDetail, RunSummary, Workflow } from "./types";

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

export function App() {
  const { fitView, screenToFlowPosition, setCenter } = useReactFlow();
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>("");
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string>("");
  const [expandedRunProcessIds, setExpandedRunProcessIds] = useState<Set<string>>(() => new Set());
  const [nodeContextMenu, setNodeContextMenu] = useState<CanvasNodeContextMenu>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const workflowIdRef = useRef<string | null>(null);
  const explicitRunSelectionRef = useRef("");

  const clearWorkflowSelection = useCallback(() => {
    setSelectedRun(null);
    setSelectedProcessId("");
    setSelectedArtifactId("");
  }, []);

  const selectLoadedWorkflow = useCallback((loaded: Workflow, mode: "processOnly" | "artifactFallback") => {
    setSelectedProcessId(loaded.processes[0]?.id ?? "");
    setSelectedArtifactId(
      mode === "artifactFallback" && loaded.processes.length === 0 ? (loaded.artifacts[0]?.id ?? "") : ""
    );
  }, []);

  const {
    cost,
    createWorkflow,
    deleteCurrentWorkflow,
    exportCurrentWorkflow,
    importWorkflowFile,
    loadInitialWorkflow,
    loadWorkflow,
    refreshWorkflow,
    selectWorkflow,
    setCost,
    setWorkflow,
    setWorkflows,
    workflow,
    workflowImportRef,
    workflows
  } = useWorkflowActions({
    onClearSelection: clearWorkflowSelection,
    onWorkflowLoaded: selectLoadedWorkflow,
    setError
  });

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
  const { setWorkflowNameDraft, workflowNameDraft } = useWorkflowName({
    setError,
    setWorkflow,
    setWorkflows,
    workflow
  });

  useEffect(() => {
    workflowIdRef.current = workflow?.id ?? null;
  }, [workflow?.id]);

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

  const {
    answerQA,
    currentReview,
    diffBaseId,
    diffLoading,
    diffTargetId,
    diffText,
    feedback,
    loadRunDiff,
    pendingQA,
    qaAnswer,
    resumeSelectedRun,
    reviewExpanded,
    reviewRun,
    setDiffBaseId,
    setDiffTargetId,
    setFeedback,
    setQaAnswer,
    setReviewExpanded,
    setRunDiffPair
  } = useRunReview({
    artifactById,
    loadWorkflow,
    selectedRun,
    setError,
    setSelectedRun,
    workflowId: workflow?.id ?? null
  });

  const {
    agentsBase,
    artifactDraft,
    processDraft,
    saveArtifact,
    saveProcess,
    setArtifactDraft,
    setProcessDraft,
    toggleSkill,
    updateArtifactDraft,
    updateProcessDraft,
    uploadArtifactSourceFile
  } = useDrafts({
    explicitRunSelectionRef,
    loadWorkflow,
    selectedArtifact,
    selectedArtifactHasProducer: Boolean(selectedArtifactProducer),
    selectedArtifactId,
    selectedProcess,
    selectedProcessId,
    setError,
    setRunDiffPair,
    setSelectedRun,
    workflow,
    workflowIdRef
  });

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
      await loadInitialWorkflow();
      await loadInitialSkillState();
      void refreshHealth();
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadInitialSkillState, loadInitialWorkflow, refreshHealth]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

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

  const { edges, nodes, onNodesChange } = useFlowGraph({
    fitView,
    onRunProcess: runProcess,
    onSelectArtifact: selectArtifact,
    onSelectProcess: selectProcess,
    selectedArtifactId,
    selectedProcessId,
    workflow
  });

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

  const usage = totalUsage(selectedRun);
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
            onRefreshWorkflow={() => void refreshWorkflow()}
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
              onReview={(action) => void reviewRun(action)}
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
