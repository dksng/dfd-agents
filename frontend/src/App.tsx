import { useReactFlow } from "@xyflow/react";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "./api";
import { ActivityPanel } from "./components/ActivityPanel";
import { ArtifactInspector } from "./components/ArtifactInspector";
import { CanvasPanel } from "./components/CanvasPanel";
import { LeftPanel } from "./components/LeftPanel";
import { ProcessInspector } from "./components/ProcessInspector";
import { RunReviewPanel } from "./components/RunReviewPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Topbar } from "./components/Topbar";
import { useArtifactPreview } from "./hooks/useArtifactPreview";
import { useCanvasActions } from "./hooks/useCanvasActions";
import { useDrafts } from "./hooks/useDrafts";
import { useFlowGraph } from "./hooks/useFlowGraph";
import { useGoalAutocomplete } from "./hooks/useGoalAutocomplete";
import { useHealth } from "./hooks/useHealth";
import { useRunReview } from "./hooks/useRunReview";
import { useRunStream } from "./hooks/useRunStream";
import { useSkills } from "./hooks/useSkills";
import { useWorkflowActions } from "./hooks/useWorkflowActions";
import { useWorkflowName } from "./hooks/useWorkflowName";
import type { CostSummary, RunDetail, RunSummary, Workflow } from "./types";

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
    addArtifact,
    addProcess,
    canvasRef,
    copyNode,
    deleteEdge,
    deleteNode,
    deleteSelectedArtifact,
    deleteSelectedProcess,
    nodeContextMenu,
    onConnect,
    setNodeContextMenu,
    updateNodePosition
  } = useCanvasActions({
    artifactDraft,
    loadWorkflow,
    processDraft,
    screenToFlowPosition,
    selectArtifact,
    selectProcess,
    selectedArtifactId,
    selectedProcessId,
    setArtifactDraft,
    setError,
    setProcessDraft,
    setSelectedArtifactId,
    setSelectedProcessId,
    setSelectedRun,
    workflow
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
                onDeleteEdge={(edgeId) => void deleteEdge(edgeId)}
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
