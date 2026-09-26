"""The domain model: pure functions over immutable data.

No I/O, no clock, no randomness, and no imports outside this package beyond the few standard-library
modules that are themselves pure; ``scripts/check_boundaries.py`` fails the build otherwise. Callers
supply ids and timestamps, which is what makes every rule here deterministic.

The rules are the same rules api-go and api-ts enforce. Keeping three implementations honest is the
point: the architecture is the claim, and a claim that only holds in one language is not one.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Final, Literal, get_args

Status = Literal["todo", "in_progress", "done"]
STATUSES: Final[tuple[Status, ...]] = get_args(Status)

MAX_TITLE_LENGTH: Final = 200

DomainErrorCode = Literal[
    "EMPTY_TITLE",
    "TITLE_TOO_LONG",
    "UNKNOWN_STATUS",
    "INVALID_TRANSITION",
    "NOT_FOUND",
]


class DomainError(Exception):
    """A rule refused the operation. The code is what the transport maps to a status."""

    def __init__(self, code: DomainErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: Final = code
        self.message: Final = message


@dataclass(frozen=True, slots=True)
class Task:
    id: str
    title: str
    status: Status
    created_at: str
    updated_at: str


# Every legal move. Anything absent is refused, including staying put.
_NEXT: Final[dict[Status, tuple[Status, ...]]] = {
    "todo": ("in_progress",),
    "in_progress": ("todo", "done"),
    "done": (),
}


def next_statuses(status: Status) -> tuple[Status, ...]:
    return _NEXT[status]


# The characters with Unicode's White_Space property, which a title is trimmed of at both ends
# (scripts/rules/task-rules.json): what Go's strings.TrimSpace removes. str.strip() would also take
# U+001C to U+001F. Python's re has no \p{...}, so they are listed; the contract's cases, built from the
# property itself, fail when this list and the property differ.
TITLE_WHITESPACE = (
    "\t\n\x0b\x0c\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)


def create_task(task_id: str, title: str, now: str) -> Task:
    trimmed = title.strip(TITLE_WHITESPACE)
    if trimmed == "":
        raise DomainError("EMPTY_TITLE", "title must not be empty")
    # Python strings are sequences of code points, so len() is the same count api-go and api-ts use.
    if len(trimmed) > MAX_TITLE_LENGTH:
        raise DomainError("TITLE_TOO_LONG", f"title must be at most {MAX_TITLE_LENGTH} characters")
    return Task(id=task_id, title=trimmed, status="todo", created_at=now, updated_at=now)


def parse_status(value: object) -> Status:
    if value in STATUSES:
        # The membership test narrows the type; no cast is needed and none is allowed.
        return value
    raise DomainError("UNKNOWN_STATUS", f"status must be one of {', '.join(STATUSES)}")


def transition(task: Task, nxt: Status, now: str) -> Task:
    if nxt not in _NEXT[task.status]:
        raise DomainError("INVALID_TRANSITION", f"cannot move a task from {task.status} to {nxt}")
    return replace(task, status=nxt, updated_at=now)
