import { Handle, Position } from "@xyflow/react";
import { FileText, Link, Play, Type } from "lucide-react";
import { compactModelName } from "../lib/format";
import type { ArtifactNode, ArtifactType, ProcessNode } from "../types";
import { StatusPill } from "./StatusPill";

export type ProcessNodeData = {
  process: ProcessNode;
  selected: boolean;
  inputCount: number;
  outputCount: number;
  state: string;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
};

export type ArtifactNodeData = {
  artifact: ArtifactNode;
  selected: boolean;
  producerName?: string;
  state: string;
  consumerCount: number;
  onSelect: (id: string) => void;
};

export type FlowNodeData = ProcessNodeData | ArtifactNodeData;

function ArtifactIcon({ type }: { type: ArtifactType }) {
  if (type === "file") {
    return <FileText size={16} />;
  }
  if (type === "url") {
    return <Link size={16} />;
  }
  return <Type size={16} />;
}

export function ProcessFlowNode({ data }: { data: ProcessNodeData }) {
  const skills = data.process.skills ?? [];
  const skillLabel =
    skills.length === 0
      ? "No skills"
      : skills.length === 1
        ? skills[0].skill_name
        : `${skills[0].skill_name} +${skills.length - 1}`;
  return (
    <div
      className={`flow-node process-node node-state-${data.state} ${data.selected ? "selected" : ""}`}
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
        <StatusPill status={data.state} />
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

export function ArtifactFlowNode({ data }: { data: ArtifactNodeData }) {
  return (
    <div
      className={`flow-node artifact-node node-state-${data.state} ${data.selected ? "selected" : ""}`}
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
        <StatusPill status={data.state} />
      </div>
      <div className="node-stats">
        <span>{data.consumerCount} consumers</span>
      </div>
    </div>
  );
}
