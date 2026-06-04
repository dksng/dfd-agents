import type { Connection } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import type { CanvasNodeContextMenu } from "../components/CanvasPanel";
import { processPayload } from "../lib/payloads";
import { artifactsConnectedToProcess } from "../lib/workflow";
import type { ArtifactNode, ArtifactType, ProcessNode, RunDetail, Workflow } from "../types";

type FlowPosition = { x: number; y: number };

type UseCanvasActionsArgs = {
  artifactDraft: ArtifactNode | null;
  loadWorkflow: (id: string) => Promise<Workflow>;
  processDraft: ProcessNode | null;
  screenToFlowPosition: (position: FlowPosition) => FlowPosition;
  selectArtifact: (id: string) => void;
  selectProcess: (id: string) => void;
  selectedArtifactId: string;
  selectedProcessId: string;
  setArtifactDraft: (value: ArtifactNode | null) => void;
  setError: (message: string) => void;
  setProcessDraft: (value: ProcessNode | null) => void;
  setSelectedArtifactId: (id: string) => void;
  setSelectedProcessId: (id: string) => void;
  setSelectedRun: (value: RunDetail | null) => void;
  workflow: Workflow | null;
};

export function useCanvasActions({
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
}: UseCanvasActionsArgs) {
  const [nodeContextMenu, setNodeContextMenu] = useState<CanvasNodeContextMenu>(null);
  const canvasRef = useRef<HTMLElement | null>(null);

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
    [screenToFlowPosition, workflow]
  );

  const addProcess = useCallback(async () => {
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
  }, [loadWorkflow, nextCanvasPosition, selectProcess, workflow]);

  const addArtifact = useCallback(
    async (type: ArtifactType = "text") => {
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
    },
    [loadWorkflow, nextCanvasPosition, selectArtifact, workflow]
  );

  const deleteNode = useCallback(
    async (kind: "process" | "artifact", id: string) => {
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
    },
    [
      loadWorkflow,
      selectedArtifactId,
      selectedProcessId,
      setArtifactDraft,
      setProcessDraft,
      setSelectedArtifactId,
      setSelectedProcessId,
      setSelectedRun,
      workflow
    ]
  );

  const deleteSelectedProcess = useCallback(async () => {
    if (!processDraft || !workflow) {
      return;
    }
    await deleteNode("process", processDraft.id);
  }, [deleteNode, processDraft, workflow]);

  const deleteSelectedArtifact = useCallback(async () => {
    if (!artifactDraft || !workflow) {
      return;
    }
    await deleteNode("artifact", artifactDraft.id);
  }, [artifactDraft, deleteNode, workflow]);

  const copyNode = useCallback(
    async (kind: "process" | "artifact", id: string) => {
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
    },
    [loadWorkflow, setSelectedArtifactId, setSelectedProcessId, workflow]
  );

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
    [loadWorkflow, setError, workflow]
  );

  const updateNodePosition = useCallback(
    async (nodeId: string, x: number, y: number) => {
      if (!workflow) {
        return;
      }
      if (workflow.processes.some((process) => process.id === nodeId)) {
        await api.updateProcessConfig(nodeId, { pos_x: x, pos_y: y });
      } else if (workflow.artifacts.some((artifact) => artifact.id === nodeId)) {
        await api.updateArtifact(nodeId, { pos_x: x, pos_y: y });
      }
      await loadWorkflow(workflow.id);
    },
    [loadWorkflow, workflow]
  );

  const deleteEdge = useCallback(
    async (edgeId: string) => {
      if (!workflow) {
        return;
      }
      await api.deleteEdge(edgeId);
      await loadWorkflow(workflow.id);
    },
    [loadWorkflow, workflow]
  );

  return {
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
  };
}
