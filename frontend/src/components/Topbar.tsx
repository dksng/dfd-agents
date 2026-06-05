import { Bell, BellOff, Settings as SettingsIcon } from "lucide-react";
import type { CostSummary } from "../types";

type TopbarProps = {
  workflowNameDraft: string;
  cost: CostSummary | null;
  notifyEnabled: boolean;
  notifySupported: boolean;
  notifyPermission: NotificationPermission | "unsupported";
  onToggleNotify: () => void;
  onWorkflowNameChange: (value: string) => void;
  onOpenSettings: () => void;
};

export function Topbar({
  workflowNameDraft,
  cost,
  notifyEnabled,
  notifySupported,
  notifyPermission,
  onToggleNotify,
  onWorkflowNameChange,
  onOpenSettings
}: TopbarProps) {
  const blocked = notifyEnabled && notifySupported && notifyPermission !== "granted";
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
        className={`icon-button ${notifyEnabled ? "active" : ""} ${blocked ? "blocked" : ""}`}
        title={
          !notifySupported
            ? "Desktop notifications are unavailable; app toasts will be used"
            : blocked
              ? "Notifications are ON but the browser/OS is blocking desktop popups — allow this site in browser settings and check OS Focus Assist. In-app toasts are used meanwhile."
              : notifyEnabled
                ? "Notifications enabled (QA / review / failures)"
                : "Enable notifications (QA / review / failures)"
        }
        onClick={onToggleNotify}
      >
        {notifyEnabled ? <Bell size={16} /> : <BellOff size={16} />}
      </button>
      <button className="icon-button" title="Settings" onClick={onOpenSettings}>
        <SettingsIcon size={16} />
      </button>
    </header>
  );
}
