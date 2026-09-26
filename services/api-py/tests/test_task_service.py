import contextlib
import threading

import pytest

from api_py.adapters.memory_task_repository import MemoryTaskRepository
from api_py.application.ports import TaskRepository
from api_py.application.task_service import TaskService
from api_py.domain.task import DomainError, Task

NOW = "2026-01-02T03:04:05Z"


class FixedClock:
    def __init__(self, value: str = NOW) -> None:
        self.value = value

    def now(self) -> str:
        return self.value


class CountingIds:
    def __init__(self) -> None:
        self.issued = 0

    def next(self) -> str:
        self.issued += 1
        return f"t{self.issued}"


def service(repository: TaskRepository | None = None) -> TaskService:
    return TaskService(repository=repository or MemoryTaskRepository(), clock=FixedClock(), ids=CountingIds())


def test_the_in_memory_store_satisfies_the_port() -> None:
    # The annotation is the assertion: mypy fails the build if the shapes stop matching.
    repository: TaskRepository = MemoryTaskRepository()
    assert repository.list() == ()


def test_create_then_get_and_list_in_insertion_order() -> None:
    svc = service()
    first = svc.create("First")
    second = svc.create("Second")

    assert svc.get(first.id) == first
    assert [task.title for task in svc.list()] == ["First", "Second"]
    assert first.id != second.id


def test_a_missing_task_is_not_found() -> None:
    with pytest.raises(DomainError) as caught:
        service().get("nope")
    assert caught.value.code == "NOT_FOUND"


def test_a_refused_move_stores_nothing() -> None:
    svc = service()
    task = svc.create("Write the README")

    with pytest.raises(DomainError) as caught:
        svc.transition(task.id, "done")
    assert caught.value.code == "INVALID_TRANSITION"
    assert svc.get(task.id).status == "todo"

    assert svc.transition(task.id, "in_progress").status == "in_progress"
    assert svc.get(task.id).status == "in_progress"


def test_re_saving_a_task_keeps_its_place() -> None:
    svc = service()
    first = svc.create("First")
    svc.create("Second")
    svc.transition(first.id, "in_progress")

    assert [task.title for task in svc.list()] == ["First", "Second"]


def test_save_replaces_and_the_store_is_not_shared_by_reference() -> None:
    repository = MemoryTaskRepository()
    task = Task(id="t1", title="One", status="todo", created_at=NOW, updated_at=NOW)
    repository.save(task)
    listed = repository.list()
    repository.save(Task(id="t1", title="Two", status="todo", created_at=NOW, updated_at=NOW))

    # The earlier listing is a snapshot: a later write must not reach through it.
    assert [item.title for item in listed] == ["One"]
    assert [item.title for item in repository.list()] == ["Two"]


class RacingRepository(MemoryTaskRepository):
    """While gated, the first two reads wait for each other: two moves at once both read, then both write."""

    def __init__(self) -> None:
        super().__init__()
        self.gate: threading.Barrier | None = None

    def get(self, task_id: str) -> Task | None:
        task = super().get(task_id)
        gate = self.gate
        if gate is not None:
            with contextlib.suppress(threading.BrokenBarrierError):
                gate.wait(timeout=5)
        return task


def test_of_two_moves_at_once_exactly_one_is_made() -> None:
    repository = RacingRepository()
    svc = service(repository)
    task = svc.create("Ship it")
    svc.transition(task.id, "in_progress")
    repository.gate = threading.Barrier(2, action=lambda: setattr(repository, "gate", None))
    outcomes: list[str] = []

    def move() -> None:
        try:
            svc.transition(task.id, "done")
            outcomes.append("made")
        except DomainError as err:
            outcomes.append(err.code)

    threads = [threading.Thread(target=move) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(outcomes) == ["INVALID_TRANSITION", "made"]
