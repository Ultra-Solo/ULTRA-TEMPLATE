import pytest

from api_py.domain.task import (
    MAX_TITLE_LENGTH,
    STATUSES,
    DomainError,
    create_task,
    next_statuses,
    parse_status,
    transition,
)

NOW = "2026-01-02T03:04:05Z"
LATER = "2026-01-02T04:00:00Z"


def code(fn) -> str:  # type: ignore[no-untyped-def]
    with pytest.raises(DomainError) as caught:
        fn()
    return caught.value.code


def test_create_trims_and_refuses_empty_or_long_titles() -> None:
    task = create_task("t1", "  Write the README  ", NOW)
    assert (task.title, task.status, task.created_at, task.updated_at) == ("Write the README", "todo", NOW, NOW)

    assert code(lambda: create_task("t1", "   ", NOW)) == "EMPTY_TITLE"
    # Counted in code points, so 200 astral characters are legal and 201 ASCII ones are not.
    assert len(create_task("t1", "\U0001f642" * MAX_TITLE_LENGTH, NOW).title) == MAX_TITLE_LENGTH
    assert code(lambda: create_task("t1", "a" * (MAX_TITLE_LENGTH + 1), NOW)) == "TITLE_TOO_LONG"


def test_only_documented_statuses_parse() -> None:
    assert parse_status("in_progress") == "in_progress"
    assert code(lambda: parse_status("In Progress")) == "UNKNOWN_STATUS"
    assert code(lambda: parse_status(None)) == "UNKNOWN_STATUS"
    assert code(lambda: parse_status(1)) == "UNKNOWN_STATUS"


def test_the_legal_moves_are_the_ones_the_other_services_accept() -> None:
    assert next_statuses("todo") == ("in_progress",)
    assert next_statuses("in_progress") == ("todo", "done")
    assert next_statuses("done") == ()
    assert set(STATUSES) == {"todo", "in_progress", "done"}


def test_transition_moves_forward_and_refuses_everything_else() -> None:
    task = create_task("t1", "Write the README", NOW)
    started = transition(task, "in_progress", LATER)
    assert (started.status, started.updated_at, started.created_at) == ("in_progress", LATER, NOW)
    assert transition(started, "done", LATER).status == "done"

    assert code(lambda: transition(task, "done", LATER)) == "INVALID_TRANSITION"
    # Staying put is a move like any other, and is not one of them.
    assert code(lambda: transition(task, "todo", LATER)) == "INVALID_TRANSITION"
    assert code(lambda: transition(transition(started, "done", LATER), "todo", LATER)) == "INVALID_TRANSITION"


def test_tasks_are_immutable() -> None:
    task = create_task("t1", "Write the README", NOW)
    with pytest.raises(AttributeError):
        task.status = "done"  # type: ignore[misc]


def test_create_trims_the_unicode_white_space_property_and_nothing_else() -> None:
    # Built from code points: the formatter writes these escapes back as the invisible characters.
    nel, ideographic_space, paragraph_separator, nbsp, bom = (chr(cp) for cp in (0x85, 0x3000, 0x2029, 0xA0, 0xFEFF))
    # str.strip() would also take U+001C to U+001F, which are not White_Space.
    assert create_task("t1", f"{nel}{ideographic_space}a{paragraph_separator}", NOW).title == "a"
    assert create_task("t1", f"\x1fa{bom}", NOW).title == f"\x1fa{bom}"
    assert code(lambda: create_task("t1", f"{nel}{nbsp}", NOW)) == "EMPTY_TITLE"
