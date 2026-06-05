import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Inbox,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
  Upload
} from "lucide-react";
import type { RefObject } from "react";
import { formatCost } from "../lib/format";
import type { AttentionSummary, ProcessNode, RunSummary, Workflow } from "../types";
import { StatusPill } from "./StatusPill";

function AttentionBadges({ attention }: { attention: AttentionSummary }) {
  const items: { key: string; count: number; title: string; icon: typeof Inbox }[] = [
    { key: "waiting_qa", count: attention.waiting_qa, title: "QA待ち", icon: MessageSquare },
    { key: "in_review", count: attention.in_review, title: "レビュー待ち", icon: Inbox },
    { key: "failed", count: attention.failed, title: "失敗", icon: AlertTriangle }
  ].filter((item) => item.count > 0);
  if (items.length === 0) return null;
  return (
    <span className="attn-badges">
      {items.map(({ key, count, title, icon: Icon }) => (
        <span key={key} className={`attn-badge attn-${key}`} title={`${title}: ${count}`}>
          <Icon size={12} />
          {count}
        </span>
      ))}
    </span>
  );
}

export type RunProcessSummary = {
  process: ProcessNode;
  runs: RunSummary[];
  latestRun: RunSummary | undefined;
  totalCost: number;
};

type LeftPanelProps = {
  workflows: Workflow[];
  workflow: Workflow | null;
  workflowRunCost: number;
  workflowImportRef: RefObject<HTMLInputElement | null>;
  runProcessSummaries: RunProcessSummary[];
  expandedRunProcessIds: Set<string>;
  selectedProcessId: string;
  selectedRunId: string | null;
  onCreateWorkflow: () => void;
  onExportWorkflow: () => void;
  onImportWorkflowFile: (file: File | null) => void;
  onDeleteWorkflow: () => void;
  onSelectWorkflow: (workflowId: string) => void;
  attentionFor: (workflowId: string) => AttentionSummary;
  onRefreshWorkflow: () => void;
  onSelectProcess: (processId: string) => void;
  onToggleRunProcess: (processId: string) => void;
  onSelectRun: (processId: string, runId: string) => void;
};

export function LeftPanel({
  workflows,
  workflow,
  workflowRunCost,
  workflowImportRef,
  runProcessSummaries,
  expandedRunProcessIds,
  selectedProcessId,
  selectedRunId,
  onCreateWorkflow,
  onExportWorkflow,
  onImportWorkflowFile,
  onDeleteWorkflow,
  onSelectWorkflow,
  attentionFor,
  onRefreshWorkflow,
  onSelectProcess,
  onToggleRunProcess,
  onSelectRun
}: LeftPanelProps) {
  return (
    <aside className="left-panel">
      <div className="panel-title">
        <strong>Workflows</strong>
        <div className="button-cluster">
          <button className="icon-button" onClick={onCreateWorkflow} title="Add workflow">
            <Plus size={16} />
          </button>
          <button className="icon-button" onClick={onExportWorkflow} title="Export workflow" disabled={!workflow}>
            <Download size={16} />
          </button>
          <button className="icon-button" onClick={() => workflowImportRef.current?.click()} title="Import workflow">
            <Upload size={16} />
          </button>
          <button
            className="icon-button danger"
            onClick={onDeleteWorkflow}
            title="Delete workflow"
            disabled={!workflow}
          >
            <Trash2 size={16} />
          </button>
        </div>
        <input
          ref={workflowImportRef}
          className="hidden-file-input"
          type="file"
          accept="application/json,.json"
          onChange={(event) => onImportWorkflowFile(event.target.files?.[0] ?? null)}
        />
      </div>
      <div className="run-list">
        {workflows.map((item) => (
          <button
            key={item.id}
            className={`run-row ${item.id === workflow?.id ? "active" : ""}`}
            onClick={() => onSelectWorkflow(item.id)}
          >
            <span className="run-main">
              <span>{item.name}</span>
              <small>{item.id.slice(0, 12)}</small>
            </span>
            <AttentionBadges attention={attentionFor(item.id)} />
          </button>
        ))}
        {workflows.length === 0 && <div className="muted-line">No workflows yet</div>}
      </div>

      <div className="panel-title">
        <strong>Runs</strong>
        <span className="run-total">{formatCost(workflowRunCost)}</span>
        <button className="icon-button" title="Refresh" onClick={onRefreshWorkflow}>
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
                  onSelectProcess(process.id);
                  onToggleRunProcess(process.id);
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
                      className={`run-row run-child-row ${run.id === selectedRunId ? "active" : ""}`}
                      onClick={() => onSelectRun(process.id, run.id)}
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
  );
}
