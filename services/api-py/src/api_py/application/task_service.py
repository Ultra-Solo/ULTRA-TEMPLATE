"""The use cases. Depends on the domain and on its ports, never on an adapter: main.py chooses those."""

from __future__ import annotations

from dataclasses import dataclass

from api_py.application.ports import Clock, IdGenerator, TaskRepository
from api_py.domain.task import DomainError, Status, Task, create_task, transition


@dataclass(frozen=True, slots=True)
class TaskService:
    repository: TaskRepository
    clock: Clock
    ids: IdGenerator

    def create(self, title: str) -> Task:
        task = create_task(self.ids.next(), title, self.clock.now())
        self.repository.save(task)
        return task

    def get(self, task_id: str) -> Task:
        task = self.repository.get(task_id)
        if task is None:
            raise DomainError("NOT_FOUND", "task not found")
        return task

    def list(self) -> tuple[Task, ...]:
        return self.repository.list()

    def transition(self, task_id: str, nxt: Status) -> Task:
        """Stores nothing when the domain refuses the move. The move replaces the task it was judged
        against, or nothing: when another change came first it is judged again against the task as
        that change left it."""
        while True:
            current = self.get(task_id)
            moved = transition(current, nxt, self.clock.now())
            if self.repository.replace(moved, current):
                return moved
