import type { SkillCandidate } from "../types";

export function skillKey(skill: Pick<SkillCandidate, "skill_source" | "skill_ref">): string {
  return `${skill.skill_source}:${skill.skill_ref}`;
}

export function skillMatchesSearch(skill: SkillCandidate, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  const haystack = [skill.name, skill.description, skill.skill_source, skill.skill_ref, skill.path]
    .join("\n")
    .toLowerCase();
  return trimmed.split(/\s+/).every((term) => haystack.includes(term));
}

export function parseRepoDraft(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
