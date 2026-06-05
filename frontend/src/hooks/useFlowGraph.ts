import { applyNodeChanges, MarkerType, type Edge, type Node, type NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlowNodeData } from "../components/FlowNodes";
import type { ArtifactNode, ProcessNode, RunSummary, Workflow, WorkflowEdge } from "../types";

type UseFlowGraphArgs = {
  fitView: (options?: { duration?: number; padding?: number }) => void;
  onRunProcess: (processId: string) => void;
  onSelectArtifact: (artifactId: string) => void;
  onSelectProcess: (processId: string) => void;
  selectedArtifactId: string;
  selectedProcessId: string;
  workflow: Workflow | null;
};

function sourceArtifactReady(artifact: ArtifactNode): boolean {
  if (artifact.type === "file") {
    return Boolean(artifact.source_file_path);
  }
  if (artifact.type === "url") {
    return Boolean(artifact.source_url);
  }
  return Boolean(artifact.source_text);
}

function latestApprovedRun(process: ProcessNode | undefined): RunSummary | undefined {
  return process?.runs.find((run) => run.status === "approved");
}

function latestRun(process: ProcessNode | undefined): RunSummary | undefined {
  return process?.runs[0];
}

function runStartedAfter(candidate: RunSummary | undefined, baseline: RunSummary | undefined): boolean {
  if (!candidate || !baseline) {
    return false;
  }
  return Date.parse(candidate.started_at) > Date.parse(baseline.started_at);
}

function runMayProduceNewOutput(run: RunSummary | undefined): boolean {
  return Boolean(run && ["draft", "running", "waiting_qa", "in_review"].includes(run.status));
}

function canShowDependencyState(state: string): boolean {
  return state === "approved" || state === "in_review" || state === "upstream_pending";
}

function baseProcessState(process: ProcessNode): string {
  return process.runs?.[0]?.status ?? "not_started";
}

function sourceChangedSinceRun(artifact: ArtifactNode, run: RunSummary): boolean {
  const inputs = Array.isArray(run.input_snapshot_json?.input) ? run.input_snapshot_json.input : [];
  const snapshot = inputs.find((item) => item && typeof item === "object" && item.id === artifact.id);
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  if (artifact.type === "text") {
    return (snapshot.text ?? "") !== (artifact.source_text ?? "");
  }
  if (artifact.type === "url") {
    return (snapshot.url ?? "") !== (artifact.source_url ?? "");
  }
  const currentName = (artifact.source_file_path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const snapshotName = String(snapshot.path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  return Boolean(currentName && snapshotName && currentName !== snapshotName);
}

function buildNodeStates(
  processes: ProcessNode[],
  artifacts: ArtifactNode[],
  edges: WorkflowEdge[],
  producerByArtifact: Map<string, string>
): { artifactStateById: Map<string, string>; processStateById: Map<string, string> } {
  const processById = new Map(processes.map((process) => [process.id, process]));
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const consumesByProcess = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    if (edge.kind === "consumes") {
      const existing = consumesByProcess.get(edge.process_id) ?? [];
      existing.push(edge);
      consumesByProcess.set(edge.process_id, existing);
    }
  }

  const processStateById = new Map(processes.map((process) => [process.id, baseProcessState(process)]));
  const artifactStateById = new Map(
    artifacts.map((artifact) => [artifact.id, sourceArtifactReady(artifact) ? "source_ready" : "source_missing"])
  );

  for (let i = 0; i < processes.length + artifacts.length; i += 1) {
    let changed = false;
    for (const artifact of artifacts) {
      const producerId = producerByArtifact.get(artifact.id);
      if (!producerId) {
        continue;
      }
      const producerState = processStateById.get(producerId) ?? "not_started";
      const next = producerState === "stale" ? "stale" : producerState;
      if (artifactStateById.get(artifact.id) !== next) {
        artifactStateById.set(artifact.id, next);
        changed = true;
      }
    }

    for (const process of processes) {
      const current = processStateById.get(process.id) ?? "not_started";
      const latest = process.runs?.[0];
      if (!latest || !canShowDependencyState(current)) {
        continue;
      }
      let hasStaleInput = false;
      let hasPendingInput = false;
      for (const edge of consumesByProcess.get(process.id) ?? []) {
        const artifactState = artifactStateById.get(edge.artifact_id);
        if (artifactState === "stale") {
          hasStaleInput = true;
          break;
        }
        if (artifactState === "upstream_pending") {
          hasPendingInput = true;
          continue;
        }
        const artifact = artifactById.get(edge.artifact_id);
        const producerId = producerByArtifact.get(edge.artifact_id);
        const producer = producerId ? processById.get(producerId) : undefined;
        if (producer) {
          if (runStartedAfter(latestApprovedRun(producer), latest)) {
            hasStaleInput = true;
            break;
          }
          if (runMayProduceNewOutput(latestRun(producer))) {
            hasPendingInput = true;
          }
        } else if (artifact && sourceChangedSinceRun(artifact, latest)) {
          hasStaleInput = true;
          break;
        }
      }
      const next = hasStaleInput ? "stale" : hasPendingInput ? "upstream_pending" : "";
      if (next && current !== next) {
        processStateById.set(process.id, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return { artifactStateById, processStateById };
}

export function useFlowGraph({
  fitView,
  onRunProcess,
  onSelectArtifact,
  onSelectProcess,
  selectedArtifactId,
  selectedProcessId,
  workflow
}: UseFlowGraphArgs) {
  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>([]);
  const fittedWorkflowRef = useRef("");

  const computedNodes = useMemo<Node<FlowNodeData>[]>(() => {
    const processes = workflow?.processes ?? [];
    const artifacts = workflow?.artifacts ?? [];
    const workflowEdges = workflow?.edges ?? [];
    const producerByArtifact = new Map<string, string>();
    const consumersByArtifact = new Map<string, number>();
    const inputCountByProcess = new Map<string, number>();
    const outputCountByProcess = new Map<string, number>();
    for (const edge of workflowEdges) {
      if (edge.kind === "produces") {
        producerByArtifact.set(edge.artifact_id, edge.process_id);
        outputCountByProcess.set(edge.process_id, (outputCountByProcess.get(edge.process_id) ?? 0) + 1);
      } else {
        consumersByArtifact.set(edge.artifact_id, (consumersByArtifact.get(edge.artifact_id) ?? 0) + 1);
        inputCountByProcess.set(edge.process_id, (inputCountByProcess.get(edge.process_id) ?? 0) + 1);
      }
    }
    const processNameById = new Map(processes.map((process) => [process.id, process.name]));
    const { artifactStateById, processStateById } = buildNodeStates(
      processes,
      artifacts,
      workflowEdges,
      producerByArtifact
    );
    return [
      ...processes.map((process) => ({
        id: process.id,
        type: "process",
        position: { x: process.pos_x, y: process.pos_y },
        data: {
          process,
          selected: process.id === selectedProcessId,
          inputCount: inputCountByProcess.get(process.id) ?? 0,
          outputCount: outputCountByProcess.get(process.id) ?? 0,
          state: processStateById.get(process.id) ?? "not_started",
          onSelect: onSelectProcess,
          onRun: (id: string) => onRunProcess(id)
        }
      })),
      ...artifacts.map((artifact) => {
        const producerId = producerByArtifact.get(artifact.id);
        return {
          id: artifact.id,
          type: "artifact",
          position: { x: artifact.pos_x, y: artifact.pos_y },
          data: {
            artifact,
            selected: artifact.id === selectedArtifactId,
            producerName: producerId ? processNameById.get(producerId) : undefined,
            state: artifactStateById.get(artifact.id) ?? "source_missing",
            consumerCount: consumersByArtifact.get(artifact.id) ?? 0,
            onSelect: onSelectArtifact
          }
        };
      })
    ];
  }, [onRunProcess, onSelectArtifact, onSelectProcess, selectedArtifactId, selectedProcessId, workflow]);

  // Keep React Flow controlled while allowing drag updates to apply locally.
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

  return { edges, nodes, onNodesChange };
}
