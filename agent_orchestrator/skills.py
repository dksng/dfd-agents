from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .exceptions import AppValidationError


@dataclass(frozen=True)
class SkillCandidate:
    name: str
    skill_source: str
    skill_ref: str
    path: str
    description: str

    def as_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "skill_source": self.skill_source,
            "skill_ref": self.skill_ref,
            "path": self.path,
            "description": self.description,
        }


class SkillRegistry:
    def __init__(self, settings: Settings):
        self.settings = settings

    def list_skills(self, repo: str | None = None, refresh: bool = False) -> dict[str, object]:
        repos = [repo] if repo else list(self.settings.skill_repos)
        local_default = self.settings.project_root / ".claude" / "skills"
        if not repos and local_default.exists():
            repos = [str(local_default)]

        candidates: list[SkillCandidate] = []
        errors: list[str] = []
        for item in repos:
            try:
                candidates.extend(self._scan_repo(item, refresh=refresh))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{item}: {exc}")
        unique: dict[tuple[str, str, str], SkillCandidate] = {}
        for candidate in candidates:
            unique[(candidate.name, candidate.skill_source, candidate.skill_ref)] = candidate
        return {
            "skills": [candidate.as_dict() for candidate in sorted(unique.values(), key=lambda s: s.name)],
            "errors": errors,
        }

    def copy_skill(self, skill_name: str, skill_source: str, skill_ref: str, destination: Path) -> None:
        source_path = self._resolve_skill_path(skill_source, skill_ref)
        if not source_path.exists():
            raise FileNotFoundError(f"Skill not found: {skill_ref}")
        target = destination / skill_name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source_path, target, ignore=shutil.ignore_patterns(".git", "__pycache__"))

    def _scan_repo(self, repo: str, refresh: bool) -> list[SkillCandidate]:
        path = Path(repo).expanduser()
        if path.exists():
            return self._scan_path(path.resolve(), "local", None)
        cache = self._prepare_git_repo(repo, refresh=refresh)
        return self._scan_path(cache, "git", repo)

    def _scan_path(self, root: Path, source: str, repo_spec: str | None) -> list[SkillCandidate]:
        candidates: list[SkillCandidate] = []
        for skill_md in root.rglob("SKILL.md"):
            if ".git" in skill_md.parts:
                continue
            skill_dir = skill_md.parent
            rel = skill_dir.relative_to(root).as_posix()
            skill_ref = str(skill_dir) if source == "local" else f"{repo_spec}#{rel}"
            candidates.append(
                SkillCandidate(
                    name=skill_dir.name,
                    skill_source=source,
                    skill_ref=skill_ref,
                    path=str(skill_dir),
                    description=self._extract_description(skill_md),
                )
            )
        return candidates

    def _extract_description(self, skill_md: Path) -> str:
        lines = skill_md.read_text(encoding="utf-8", errors="replace").splitlines()
        if lines and lines[0].strip() == "---":
            for line in lines[1:]:
                stripped = line.strip()
                if stripped == "---":
                    break
                if stripped.startswith("description:"):
                    value = stripped.split(":", 1)[1].strip()
                    return value.strip("\"'")[:500]
        in_frontmatter = bool(lines and lines[0].strip() == "---")
        for line in lines[1:] if in_frontmatter else lines:
            stripped = line.strip()
            if in_frontmatter:
                if stripped == "---":
                    in_frontmatter = False
                continue
            if not stripped or stripped.startswith("#"):
                continue
            return stripped[:240]
        return ""

    def _resolve_skill_path(self, skill_source: str, skill_ref: str) -> Path:
        if skill_source == "local":
            return Path(skill_ref).expanduser().resolve()
        if "#" not in skill_ref:
            raise AppValidationError("Git skill_ref must be '<owner>/<repo>[@ref]#<skill-path>'")
        repo_spec, rel = skill_ref.split("#", 1)
        return (self._prepare_git_repo(repo_spec, refresh=False) / rel).resolve()

    def _prepare_git_repo(self, repo_spec: str, refresh: bool) -> Path:
        repo, ref = self._parse_git_repo(repo_spec)
        cache_dir = self.settings.skill_cache_root / self._safe_cache_name(repo_spec)
        if refresh and cache_dir.exists():
            shutil.rmtree(cache_dir)
        if not cache_dir.exists():
            if shutil.which("gh") is None:
                raise RuntimeError("gh CLI is required for remote skill repositories")
            cache_dir.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["gh", "repo", "clone", repo, str(cache_dir)], check=True, text=True)
        if ref:
            subprocess.run(["git", "fetch", "origin", ref, "--depth", "1"], cwd=cache_dir, check=True, text=True)
            subprocess.run(["git", "checkout", "FETCH_HEAD"], cwd=cache_dir, check=True, text=True)
        return cache_dir

    def _parse_git_repo(self, repo_spec: str) -> tuple[str, str | None]:
        base = repo_spec.split("#", 1)[0]
        if "@" not in base:
            return base, None
        repo, ref = base.rsplit("@", 1)
        return repo, ref

    def _safe_cache_name(self, repo_spec: str) -> str:
        return "".join(ch if ch.isalnum() else "_" for ch in repo_spec)
