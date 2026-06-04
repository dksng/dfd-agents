import { applyNodeChanges, MarkerType, type Edge, type Node, type NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlowNodeData } from "../components/FlowNodes";
import type { Workflow } from "../types";

type UseFlowGraphArgs = {
  fitView: (options?: { duration?: number; padding?: number }) => void;
  onRunProcess: (processId: string) => void;
  onSelectArtifact: (artifactId: string) => void;
  onSelectProcess: (processId: string) => void;
  selectedArtifactId: string;
  selectedProcessId: string;
  workflow: Workflow | null;
};

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
          onSelect: onSelectProcess,
          onRun: (id: string) => onRunProcess(id)
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
