import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import { parseRepoDraft, skillKey, skillMatchesSearch } from "../lib/skills";
import type { AppSettings, ProcessNode, SkillCandidate } from "../types";

type UseSkillsArgs = {
  processSkills: ProcessNode["skills"];
  setError: (message: string) => void;
};

export function useSkills({ processSkills, setError }: UseSkillsArgs) {
  const [skills, setSkills] = useState<SkillCandidate[]>([]);
  const [skillErrors, setSkillErrors] = useState<string[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [expandedSkillKeys, setExpandedSkillKeys] = useState<Set<string>>(() => new Set());
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");

  const loadSkills = useCallback(async (refresh: boolean) => {
    const skillResponse = await api.listSkills(refresh);
    setSkills(skillResponse.skills);
    setSkillErrors(skillResponse.errors ?? []);
    return skillResponse;
  }, []);

  const loadSettings = useCallback(async () => {
    const runtimeSettings = await api.getSettings();
    setAppSettings(runtimeSettings);
    setSettingsDraft(runtimeSettings.skill_repos.join("\n"));
    return runtimeSettings;
  }, []);

  const loadInitialSkillState = useCallback(async () => {
    await loadSkills(false);
    await loadSettings();
  }, [loadSettings, loadSkills]);

  const openSettingsModal = useCallback(async () => {
    setSettingsOpen(true);
    setSettingsMessage("");
    try {
      await loadSettings();
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadSettings, setError]);

  const saveSettings = useCallback(async () => {
    setSettingsSaving(true);
    setSettingsMessage("");
    try {
      const updated = await api.updateSettings({ skill_repos: parseRepoDraft(settingsDraft) });
      setAppSettings(updated);
      setSettingsDraft(updated.skill_repos.join("\n"));
      const skillResponse = await loadSkills(true);
      setSettingsMessage(`${skillResponse.skills.length} skills available.`);
    } catch (exc) {
      setError(String(exc));
    } finally {
      setSettingsSaving(false);
    }
  }, [loadSkills, setError, settingsDraft]);

  const refreshSkills = useCallback(async () => {
    setSettingsSaving(true);
    setSettingsMessage("");
    try {
      const skillResponse = await loadSkills(true);
      setSettingsMessage(`${skillResponse.skills.length} skills available.`);
    } catch (exc) {
      setError(String(exc));
    } finally {
      setSettingsSaving(false);
    }
  }, [loadSkills, setError]);

  const toggleSkillDetails = useCallback((key: string) => {
    setExpandedSkillKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const visibleSkills = useMemo(() => {
    const selectedKeys = new Set(processSkills.map((skill) => `${skill.skill_source}:${skill.skill_ref}`));
    const selected: SkillCandidate[] = [];
    const unselected: SkillCandidate[] = [];
    for (const skill of skills) {
      const isSelected = selectedKeys.has(skillKey(skill));
      if (isSelected) {
        selected.push(skill);
      } else if (skillMatchesSearch(skill, skillSearch)) {
        unselected.push(skill);
      }
    }
    return [...selected, ...unselected];
  }, [processSkills, skillSearch, skills]);

  return {
    appSettings,
    expandedSkillKeys,
    refreshSkills,
    loadInitialSkillState,
    openSettingsModal,
    saveSettings,
    setSettingsDraft,
    setSettingsOpen,
    setSkillSearch,
    settingsDraft,
    settingsMessage,
    settingsOpen,
    settingsSaving,
    skillErrors,
    skillSearch,
    skills,
    toggleSkillDetails,
    visibleSkills
  };
}
