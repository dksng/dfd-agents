from __future__ import annotations

from enum import StrEnum


class RunStatus(StrEnum):
    DRAFT = "draft"
    RUNNING = "running"
    WAITING_QA = "waiting_qa"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    FAILED = "failed"


RUN_STATUSES_ALLOWING_SUBMIT = {RunStatus.RUNNING.value}
RUN_STATUSES_ALLOWING_REVIEW = {RunStatus.IN_REVIEW.value}
RUN_STATUSES_ALLOWING_PUBLIC_RESUME = {RunStatus.FAILED.value}


def can_submit(status: str) -> bool:
    return status in RUN_STATUSES_ALLOWING_SUBMIT


def can_review(status: str) -> bool:
    return status in RUN_STATUSES_ALLOWING_REVIEW


def can_public_resume(status: str) -> bool:
    return status in RUN_STATUSES_ALLOWING_PUBLIC_RESUME
