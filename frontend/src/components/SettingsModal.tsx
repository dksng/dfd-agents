import { RefreshCw, Save, X } from "lucide-react";
import type { AppSettings } from "../types";

type SettingsModalProps = {
  settingsDraft: string;
  settingsSaving: boolean;
  settingsMessage: string;
  skillErrors: string[];
  skillCount: number;
  appSettings: AppSettings | null;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onRefreshSkills: () => void;
};

export function SettingsModal({
  settingsDraft,
  settingsSaving,
  settingsMessage,
  skillErrors,
  skillCount,
  appSettings,
  onClose,
  onDraftChange,
  onSave,
  onRefreshSkills
}: SettingsModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="panel-title">
          <strong id="settings-title">Settings</strong>
          <button className="icon-button" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="field-block">
          <span>Skill Repositories</span>
          <textarea
            value={settingsDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            rows={7}
            placeholder={"owner/repo\nowner/repo@main\n/home/user/local-skills"}
          />
          <small className="muted-line">
            One repository per line. Local paths are allowed. GitHub repositories use gh and are cached under config.
          </small>
        </div>

        <div className="settings-facts">
          <span>Current skills</span>
          <strong>{skillCount}</strong>
          <span>Config root</span>
          <code>{appSettings?.config_root ?? ""}</code>
          <span>Skill cache</span>
          <code>{appSettings?.skill_cache_root ?? ""}</code>
        </div>

        {skillErrors.length > 0 && (
          <div className="settings-errors">
            {skillErrors.map((item) => (
              <div key={item}>{item}</div>
            ))}
          </div>
        )}
        {settingsMessage && <div className="muted-line">{settingsMessage}</div>}

        <div className="button-row">
          <button className="icon-text" disabled={settingsSaving} onClick={onSave}>
            <Save size={15} />
            Save
          </button>
          <button className="icon-text" disabled={settingsSaving} onClick={onRefreshSkills}>
            <RefreshCw size={15} />
            Refresh Skills
          </button>
        </div>
      </section>
    </div>
  );
}
