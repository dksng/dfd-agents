from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ArtifactType = Literal["file", "url", "text"]
ReviewAction = Literal["approve", "reject"]


class WorkflowCreate(BaseModel):
    name: str = "Untitled Workflow"


class WorkflowUpdate(BaseModel):
    name: str | None = None
    layout_json: dict[str, Any] | None = None


class SkillSelection(BaseModel):
    skill_name: str
    skill_source: Literal["local", "git"]
    skill_ref: str


class ProcessCreate(BaseModel):
    name: str = "New Process"
    type: str = "implement"
    pos_x: float = 120
    pos_y: float = 120


class ProcessConfigUpdate(BaseModel):
    name: str | None = None
    type: str | None = None
    agent_kind: str | None = None
    agent_model: str | None = None
    agent_effort: str | None = None
    goal_md: str | None = None
    template_id: str | None = None
    agents_md_append: str | None = None
    execution_mode: str | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    skills: list[SkillSelection] | None = None


class ArtifactCreate(BaseModel):
    name: str = "New Artifact"
    type: ArtifactType = "text"
    pos_x: float = 360
    pos_y: float = 160
    source_text: str | None = None
    source_url: str | None = None
    source_file_path: str | None = None
    spec_json: dict[str, Any] = Field(default_factory=dict)


class ArtifactUpdate(BaseModel):
    name: str | None = None
    type: ArtifactType | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    source_text: str | None = None
    source_url: str | None = None
    source_file_path: str | None = None
    spec_json: dict[str, Any] | None = None


class EdgeCreate(BaseModel):
    kind: Literal["produces", "consumes"]
    process_id: str
    artifact_id: str


class ResumeRequest(BaseModel):
    feedback_text: str = ""


class QARequest(BaseModel):
    question_text: str


class QAAnswerRequest(BaseModel):
    answer_text: str


class SubmitRequest(BaseModel):
    note: str | None = None


class ReviewRequest(BaseModel):
    action: ReviewAction
    feedback_text: str = ""
