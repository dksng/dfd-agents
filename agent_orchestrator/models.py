from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ArtifactType = Literal["file", "url", "text"]
PortDirection = Literal["in", "out"]
ReviewAction = Literal["approve", "reject"]


class WorkflowCreate(BaseModel):
    name: str = "Untitled Workflow"


class WorkflowUpdate(BaseModel):
    name: str | None = None
    layout_json: dict[str, Any] | None = None


class ArtifactPortInput(BaseModel):
    id: str | None = None
    direction: PortDirection
    artifact_name: str
    artifact_type: ArtifactType = "text"
    spec_json: dict[str, Any] = Field(default_factory=dict)


class SkillSelection(BaseModel):
    skill_name: str
    skill_source: Literal["local", "git"]
    skill_ref: str


class ProcessCreate(BaseModel):
    name: str = "New Process"
    type: str = "implement"
    pos_x: float = 120
    pos_y: float = 120
    ports: list[ArtifactPortInput] = Field(default_factory=list)


class ProcessConfigUpdate(BaseModel):
    name: str | None = None
    type: str | None = None
    agent_kind: str | None = None
    agent_model: str | None = None
    goal_md: str | None = None
    template_id: str | None = None
    agents_md_append: str | None = None
    execution_mode: str | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    ports: list[ArtifactPortInput] | None = None
    skills: list[SkillSelection] | None = None


class EdgeCreate(BaseModel):
    from_process_id: str
    from_port_id: str
    to_process_id: str
    to_port_id: str


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

