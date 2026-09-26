"""The in-memory store: what the service starts with, and the reference behaviour any other store
must match. It forgets everything on restart.

A dict preserves insertion order, so ``list`` returns tasks oldest first without keeping a second
index; a re-saved task keeps its original position, as it does in api-go and api-ts.
"""

from __future__ import annotations

import threading

from api_py.domain.task import Task


class MemoryTaskRepository:
    """Satisfies the TaskRepository port structurally; tests assert the port is satisfied."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, Task] = {}

    def save(self, task: Task) -> None:
        with self._lock:
            self._tasks[task.id] = task

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list(self) -> tuple[Task, ...]:
        with self._lock:
            return tuple(self._tasks.values())

    def replace(self, task: Task, prev: Task) -> bool:
        with self._lock:
            if self._tasks.get(prev.id) != prev:
                return False
            self._tasks[prev.id] = task
            return True
