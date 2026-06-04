import { formatCost } from "../lib/format";
import type { CostSummary, RunDetail } from "../types";
import { LogViewer } from "./LogViewer";
import { StatusPill } from "./StatusPill";

type ActivityPanelProps = {
  selectedRun: RunDetail | null;
  usage: CostSummary;
};

export function ActivityPanel({ selectedRun, usage }: ActivityPanelProps) {
  return (
    <section className="bottom-panel">
      <div className="activity-head">
        <div>
          <strong>{selectedRun ? selectedRun.id : "No run selected"}</strong>
          {selectedRun && <StatusPill status={selectedRun.status} />}
        </div>
        <div className="cost-strip">
          <span>{usage.input_tokens} in</span>
          <span>{usage.output_tokens} out</span>
          <strong>{formatCost(usage.cost_usd)}</strong>
        </div>
      </div>

      {selectedRun && (
        <div className="activity-grid log-only">
          <LogViewer key={selectedRun.id} logs={selectedRun.logs} status={selectedRun.status} />
        </div>
      )}
    </section>
  );
}
