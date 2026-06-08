import { ChevronDown, ChevronRight, Play, Save, Search, Trash2 } from "lucide-react";
import type { RefObject } from "react";
import { skillKey } from "../lib/skills";
import { PERMISSION_MODES } from "../types";
import type { ArtifactNode, HealthInfo, ModelOption, ProcessNode, SkillCandidate } from "../types";

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

type ProcessInspectorProps = {
  processDraft: ProcessNode | null;
  health: HealthInfo | null;
  skills: SkillCandidate[];
  visibleSkills: SkillCandidate[];
  skillSearch: string;
  expandedSkillKeys: Set<string>;
  goalRef: RefObject<HTMLTextAreaElement | null>;
  suggestOpen: boolean;
  goalArtifacts: ArtifactNode[];
  agentsBase: string;
  modelOptions: ModelOption[];
  onRun: () => void;
  onSave: () => void;
  onDelete: () => void;
  onUpdateDraft: <K extends keyof ProcessNode>(key: K, value: ProcessNode[K]) => void;
  onSkillSearchChange: (value: string) => void;
  onToggleSkill: (skill: SkillCandidate, checked: boolean) => void;
  onToggleSkillDetails: (key: string) => void;
  onGoalChange: (value: string, cursor: number) => void;
  onInsertArtifactToken: (artifact: ArtifactNode) => void;
};

export function ProcessInspector({
  processDraft,
  health,
  skills,
  visibleSkills,
  skillSearch,
  expandedSkillKeys,
  goalRef,
  suggestOpen,
  goalArtifacts,
  agentsBase,
  modelOptions,
  onRun,
  onSave,
  onDelete,
  onUpdateDraft,
  onSkillSearchChange,
  onToggleSkill,
  onToggleSkillDetails,
  onGoalChange,
  onInsertArtifactToken
}: ProcessInspectorProps) {
  if (!processDraft) {
    return null;
  }

  return (
    <>
      <div className="panel-title">
        <strong>Process</strong>
        <div className="button-cluster">
          <button className="icon-button" title="Run" onClick={onRun}>
            <Play size={16} />
          </button>
          <button className="icon-button" title="Save" onClick={onSave}>
            <Save size={16} />
          </button>
          <button className="icon-button danger" title="Delete" onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <label>
        Name
        <input value={processDraft.name} onChange={(event) => onUpdateDraft("name", event.target.value)} />
      </label>
      <div className="two-col">
        <label>
          Agent
          <select value={processDraft.agent_kind} onChange={(event) => onUpdateDraft("agent_kind", event.target.value)}>
            <option value="claude">claude</option>
          </select>
        </label>
        <label>
          Model
          <select
            value={processDraft.agent_model}
            onChange={(event) => onUpdateDraft("agent_model", event.target.value)}
          >
            {!modelOptions.some((model) => model.id === processDraft.agent_model) && (
              <option value={processDraft.agent_model}>{processDraft.agent_model}</option>
            )}
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Effort
        <select
          value={processDraft.agent_effort || "medium"}
          onChange={(event) => onUpdateDraft("agent_effort", event.target.value)}
        >
          {EFFORT_OPTIONS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>

      <div className="field-block">
        <span>Permissions</span>
        <label>
          Mode
          <select
            value={processDraft.permission_mode}
            onChange={(event) => onUpdateDraft("permission_mode", event.target.value)}
          >
            <option value="">inherit ({health?.default_permission_mode ?? "default"})</option>
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <label>
          Allowed tools (comma-separated)
          <input
            value={processDraft.allowed_tools}
            placeholder={health?.default_allowed_tools ?? ""}
            onChange={(event) => onUpdateDraft("allowed_tools", event.target.value)}
          />
        </label>
        <label>
          Disallowed tools
          <input
            value={processDraft.disallowed_tools}
            placeholder={health?.default_disallowed_tools || "(none)"}
            onChange={(event) => onUpdateDraft("disallowed_tools", event.target.value)}
          />
        </label>
        <small className="muted-line">
          Empty = inherit global default. Submission runs utils/submit.py via Bash, so the effective permissions must
          allow it (the default allowlist covers python; or use bypassPermissions).
        </small>
      </div>

      <div className="field-block">
        <span>Skills</span>
        <div className="skill-search">
          <Search size={14} />
          <input
            aria-label="Search skills"
            value={skillSearch}
            placeholder="Search skills"
            onChange={(event) => onSkillSearchChange(event.target.value)}
          />
        </div>
        <div className="skill-count">
          {visibleSkills.length} / {skills.length} shown
          {processDraft.skills.length > 0 ? `, ${processDraft.skills.length} selected` : ""}
        </div>
        <div className="skill-list">
          {skills.length === 0 && <div className="muted-line">No skills found</div>}
          {skills.length > 0 && visibleSkills.length === 0 && <div className="muted-line">No matching skills</div>}
          {visibleSkills.map((skill) => {
            const key = skillKey(skill);
            const expanded = expandedSkillKeys.has(key);
            const checked = processDraft.skills.some((item) => `${item.skill_source}:${item.skill_ref}` === key);
            return (
              <div className={`skill-card ${checked ? "selected" : ""}`} key={key}>
                <div className="skill-row">
                  <label className="skill-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => onToggleSkill(skill, event.target.checked)}
                    />
                    <span>
                      <strong>{skill.name}</strong>
                      <small>{skill.skill_source}</small>
                    </span>
                  </label>
                  <button
                    className="icon-button skill-expand"
                    title={expanded ? "Hide skill details" : "Show skill details"}
                    onClick={() => onToggleSkillDetails(key)}
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </div>
                {expanded && (
                  <div className="skill-detail">
                    <p>{skill.description || "No description."}</p>
                    <div className="skill-detail-grid">
                      <span>Ref</span>
                      <code>{skill.skill_ref}</code>
                      <span>Path</span>
                      <code>{skill.path}</code>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="goal-box">
        <label>
          Goal.md
          <textarea
            ref={goalRef}
            value={processDraft.goal_md}
            onChange={(event) => onGoalChange(event.target.value, event.target.selectionStart)}
            onKeyUp={(event) => onGoalChange(event.currentTarget.value, event.currentTarget.selectionStart)}
            rows={8}
          />
        </label>
        {suggestOpen && (
          <div className="suggest-list">
            {goalArtifacts.map((artifact) => (
              <button key={artifact.id} onClick={() => onInsertArtifactToken(artifact)}>
                {artifact.name}
              </button>
            ))}
            {goalArtifacts.length === 0 && <div className="muted-line">No connected artifacts</div>}
          </div>
        )}
      </div>

      <details className="agents-base">
        <summary>AGENTS.md (base template, read-only)</summary>
        <pre className="readonly-pre">{agentsBase || "(empty)"}</pre>
      </details>

      <label>
        AGENTS.md Append
        <textarea
          value={processDraft.agents_md_append}
          onChange={(event) => onUpdateDraft("agents_md_append", event.target.value)}
          rows={5}
        />
      </label>
    </>
  );
}
