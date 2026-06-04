from __future__ import annotations


class DomainError(Exception):
    """Base class for application-level errors surfaced by the API."""


class NotFoundError(DomainError):
    pass


class ConflictError(DomainError):
    pass


class AppValidationError(ValueError):
    """Application validation error; remains ValueError-compatible for internal tests."""

    pass
