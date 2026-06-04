import {
  Background,
  Controls,
  Panel as FlowPanel,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange
} from "@xyflow/react";
import { Copy, FileText, Link, Plus, Trash2, Type } from "lucide-react";
import type { RefObject } from "react";
import { ArtifactFlowNode, ProcessFlowNode, type FlowNodeData } from "./FlowNodes";

export type CanvasNodeContextMenu = {
  id: string;
  kind: "process" | "artifact";
  x: number;
  y: number;
} | null;

const nodeTypes = { process: ProcessFlowNode, artifact: ArtifactFlowNode };

type CanvasPanelProps = {
  canvasRef: RefObject<HTMLElement | null>;
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
  workflowExists: boolean;
  nodeContextMenu: CanvasNodeContextMenu;
  onNodesChange: (changes: NodeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onClearContextMenu: () => void;
  onSelectNode: (kind: "process" | "artifact", id: string) => void;
  onOpenContextMenu: (menu: NonNullable<CanvasNodeContextMenu>) => void;
  onDeleteEdge: (edgeId: string) => void;
  onUpdateNodePosition: (nodeId: string, x: number, y: number) => void;
  onAddProcess: () => void;
  onAddArtifact: (type: "text" | "file" | "url") => void;
  onCopyNode: (kind: "process" | "artifact", id: string) => void;
  onDeleteNode: (kind: "process" | "artifact", id: string) => void;
};

export function CanvasPanel({
  canvasRef,
  nodes,
  edges,
  workflowExists,
  nodeContextMenu,
  onNodesChange,
  onConnect,
  onClearContextMenu,
  onSelectNode,
  onOpenContextMenu,
  onDeleteEdge,
  onUpdateNodePosition,
  onAddProcess,
  onAddArtifact,
  onCopyNode,
  onDeleteNode
}: CanvasPanelProps) {
  return (
    <section className="canvas-panel" ref={canvasRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onPaneClick={onClearContextMenu}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          const kind = node.type === "artifact" ? "artifact" : "process";
          onSelectNode(kind, node.id);
          onOpenContextMenu({
            id: node.id,
            kind,
            x: Math.min(event.clientX, window.innerWidth - 180),
            y: Math.min(event.clientY, window.innerHeight - 96)
          });
        }}
        onEdgeDoubleClick={(_, edge) => onDeleteEdge(edge.id)}
        onNodeDragStop={(_, node) => onUpdateNodePosition(node.id, node.position.x, node.position.y)}
        fitView
      >
        <FlowPanel position="top-left" className="canvas-toolbar">
          <button className="icon-text" onClick={onAddProcess} disabled={!workflowExists}>
            <Plus size={15} />
            Process
          </button>
          <button className="icon-text" onClick={() => onAddArtifact("text")} disabled={!workflowExists}>
            <Type size={15} />
            Text
          </button>
          <button className="icon-text" onClick={() => onAddArtifact("file")} disabled={!workflowExists}>
            <FileText size={15} />
            File
          </button>
          <button className="icon-text" onClick={() => onAddArtifact("url")} disabled={!workflowExists}>
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
          <button onClick={() => onCopyNode(nodeContextMenu.kind, nodeContextMenu.id)}>
            <Copy size={14} />
            Copy
          </button>
          <button className="danger" onClick={() => onDeleteNode(nodeContextMenu.kind, nodeContextMenu.id)}>
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}
    </section>
  );
}
