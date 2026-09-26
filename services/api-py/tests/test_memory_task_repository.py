from __future__ import annotations

from api_py.adapters.memory_task_repository import MemoryTaskRepository
from api_py.domain.task import Task
from task_repository_conformance import check_task_repository


def test_the_in_memory_store_keeps_the_storage_ports_contract() -> None:
    assert check_task_repository(MemoryTaskRepository) == []


# One list, shared by every instance of the broken store below: the mistake it is there to make.
SHARED: list[Task] = []


class BrokenRepository:
    """A store with the mistakes a new adapter makes: newest first, one list every instance shares, and a
    replace that does not check the task is still the one the caller read."""

    def save(self, task: Task) -> None:
        SHARED.insert(0, task)

    def get(self, task_id: str) -> Task | None:
        return next((task for task in SHARED if task.id == task_id), None)

    def list(self) -> tuple[Task, ...]:
        return tuple(SHARED)

    def replace(self, task: Task, _prev: Task) -> bool:
        SHARED.insert(0, task)
        return True


def test_the_suite_fails_a_broken_store_naming_each_way_it_breaks_the_contract() -> None:
    problems = "\n".join(check_task_repository(BrokenRepository))
    for expected in (
        "listed oldest first",
        "two stores share nothing",
        "an empty store lists nothing",
        "a replace from a task that is out of date is refused",
        "a replace of a task never saved is refused",
    ):
        assert expected in problems, problems
