import { useReactFlow } from "@xyflow/react";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useNotifications } from "./hooks/useNotifications";
import { useRunReview } from "./hooks/useRunReview";
import { useRunSummaries } from "./hooks/useRunSummaries";
import { useRunStream } from "./hooks/useRunStream";
import { useSelectedWorkflowItems } from "./hooks/useSelectedWorkflowItems";
import { useSkills } from "./hooks/useSkills";
import { useWorkflowActions } from "./hooks/useWorkflowActions";
import { useWorkflowSync } from "./hooks/useWorkflowSync";
import { useWorkflowName } from "./hooks/useWorkflowName";
import type { ModelCatalog, RunDetail, Workflow } from "./types";

export function App() {
  const { fitView, screenToFlowPosition, setCenter } = useReactFlow();
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>("");
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string>("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
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

  // Live-sync: reflect graph changes made by another client (a second tab or an AI
  // agent driving the REST API) on this canvas without a manual reload.
  const refreshWorkflowList = useCallback(() => {
    void api
      .listWorkflows()
      .then(setWorkflows)
      .catch(() => {
        /* transient; the list refreshes again on the next event */
      });
  }, [setWorkflows]);
  useWorkflowSync({
    workflowId: workflow?.id,
    onGraphChange: refreshWorkflow,
    onListChange: refreshWorkflowList
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

  const { artifactById, selectedArtifact, selectedArtifactProducer, selectedArtifactProducerName, selectedProcess } =
    useSelectedWorkflowItems(workflow, selectedProcessId, selectedArtifactId);

  const {
    answerQA,
    currentReview,
    feedback,
    pendingQA,
    qaAnswer,
    resumeSelectedRun,
    reviewExpanded,
    reviewRun,
    setFeedback,
    setQaAnswer,
    setReviewExpanded,
    setVersionRunId,
    versionLoading,
    versionRun,
    versionRunId
  } = useRunReview({
    loadWorkflow,
    processRuns: selectedProcess?.runs ?? [],
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
      api
        .getModels()
        .then(setModelCatalog)
        .catch((exc) => setError(String(exc)));
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

  const { runProcessSummaries, usage, workflowRunCost } = useRunSummaries(workflow, selectedRun);

  const resolveNotificationLabel = useCallback(
    (workflowId: string, processId: string) => {
      if (workflow?.id === workflowId) {
        const process = workflow.processes.find((item) => item.id === processId);
        if (process) return process.name;
      }
      return workflows.find((item) => item.id === workflowId)?.name;
    },
    [workflow, workflows]
  );

  const openNotificationTarget = useCallback(
    ({ workflowId, runId }: { workflowId: string; runId: string }) => {
      const navigate = async () => {
        if (workflow?.id !== workflowId) {
          await selectWorkflow(workflowId);
        }
        explicitRunSelectionRef.current = runId;
        try {
          const run = await api.getRun(runId);
          selectProcess(run.process_id);
          setSelectedRun(run);
        } catch (exc) {
          setError(String(exc));
        }
      };
      void navigate();
    },
    [workflow, selectWorkflow, selectProcess, setSelectedRun, setError]
  );

  const notifySupported = typeof window !== "undefined" && "Notification" in window;
  const {
    enabled: notifyEnabled,
    permission: notifyPermission,
    toggle: toggleNotify,
    attentionFor,
    toasts: notificationToasts,
    dismissToast: dismissNotificationToast
  } = useNotifications({
    resolveLabel: resolveNotificationLabel,
    currentRunId: selectedRun?.id,
    onOpen: openNotificationTarget
  });

  return (
    <div className="app-shell">
      <Topbar
        workflowNameDraft={workflowNameDraft}
        cost={cost}
        notifyEnabled={notifyEnabled}
        notifySupported={notifySupported}
        notifyPermission={notifyPermission}
        onToggleNotify={toggleNotify}
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
            Mock agent active (selected CLI not detected; runs complete instantly into review). Set ORCH_AGENT_MODE or
            ensure `claude` / `copilot` is on PATH for real execution.
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

      {notificationToasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {notificationToasts.map((toast) => (
            <div className="notification-toast" key={toast.id}>
              <button
                className="toast-main"
                onClick={() => {
                  dismissNotificationToast(toast.id);
                  openNotificationTarget({ workflowId: toast.workflowId, runId: toast.runId });
                }}
              >
                <strong>{toast.title}</strong>
                <span>{toast.body}</span>
              </button>
              <button className="icon-button" title="Dismiss" onClick={() => dismissNotificationToast(toast.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
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
            attentionFor={attentionFor}
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
              versionRunId={versionRunId}
              versionRun={versionRun}
              versionLoading={versionLoading}
              onToggleExpanded={() => setReviewExpanded((value) => !value)}
              onResumeRun={() => void resumeSelectedRun()}
              onQaAnswerChange={setQaAnswer}
              onAnswerQA={() => void answerQA()}
              onFeedbackChange={setFeedback}
              onReview={(action) => void reviewRun(action)}
              onVersionRunChange={setVersionRunId}
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
              modelOptions={modelCatalog?.models ?? []}
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
