import { Bell, BellOff, Settings as SettingsIcon } from "lucide-react";
import type { CostSummary } from "../types";

type TopbarProps = {
  workflowNameDraft: string;
  cost: CostSummary | null;
  notifyEnabled: boolean;
  notifySupported: boolean;
  onToggleNotify: () => void;
  onWorkflowNameChange: (value: string) => void;
  onOpenSettings: () => void;
};

export function Topbar({
  workflowNameDraft,
  cost,
  notifyEnabled,
  notifySupported,
  onToggleNotify,
  onWorkflowNameChange,
  onOpenSettings
}: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">DFD</span>
        <strong>Agent Process Orchestrator</strong>
      </div>
      <input
        className="workflow-name"
        value={workflowNameDraft}
        onChange={(event) => onWorkflowNameChange(event.target.value)}
        placeholder="Workflow name"
        title="Rename workflow"
      />
      <div className="cost-strip">
        <span>{cost?.input_tokens ?? 0} in</span>
        <span>{cost?.output_tokens ?? 0} out</span>
        <strong>${(cost?.cost_usd ?? 0).toFixed(5)}</strong>
      </div>
      <button
        className={`icon-button ${notifyEnabled ? "active" : ""}`}
        title={
          !notifySupported
            ? "Notifications not supported by this browser"
            : notifyEnabled
              ? "Disable desktop notifications"
              : "Enable desktop notifications (QA / review / failures)"
        }
        onClick={onToggleNotify}
        disabled={!notifySupported}
      >
        {notifyEnabled ? <Bell size={16} /> : <BellOff size={16} />}
      </button>
      <button className="icon-button" title="Settings" onClick={onOpenSettings}>
        <SettingsIcon size={16} />
      </button>
    </header>
  );
}
