import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTransition,
  DomainError,
  MAX_TITLE_LENGTH,
  nextStatuses,
  parseStatus,
  parseTask,
  parseTasks,
  validateTitle,
} from "../src/domain/task.ts";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof DomainError ? err.code : `not a DomainError: ${String(err)}`;
  }
  return "no error";
};

test("a title is trimmed, and refused when empty or too long", () => {
  assert.equal(validateTitle("  write it  "), "write it");
  assert.equal(
    code(() => validateTitle("   ")),
    "EMPTY_TITLE",
  );
  // Counted in code points: 200 astral characters are 400 UTF-16 units and still legal.
  assert.equal(validateTitle("🙂".repeat(MAX_TITLE_LENGTH)).length, MAX_TITLE_LENGTH * 2);
  assert.equal(
    code(() => validateTitle("a".repeat(MAX_TITLE_LENGTH + 1))),
    "TITLE_TOO_LONG",
  );
});

test("only the documented statuses parse", () => {
  assert.equal(parseStatus("in_progress"), "in_progress");
  assert.equal(
    code(() => parseStatus("In Progress")),
    "UNKNOWN_STATUS",
  );
  assert.equal(
    code(() => parseStatus(undefined)),
    "UNKNOWN_STATUS",
  );
});

test("the legal moves are the ones the services accept, and the message names them", () => {
  assert.deepEqual(nextStatuses("todo"), ["in_progress"]);
  assert.deepEqual(nextStatuses("in_progress"), ["todo", "done"]);
  assert.deepEqual(nextStatuses("done"), []);
  assert.doesNotThrow(() => checkTransition("in_progress", "done"));
  assert.throws(() => checkTransition("todo", "done"), /legal moves from todo: in_progress/);
  assert.throws(() => checkTransition("done", "todo"), /legal moves from done: none/);
  // Staying put is a move like any other, and is not one of them.
  assert.equal(
    code(() => checkTransition("todo", "todo")),
    "INVALID_TRANSITION",
  );
});

test("a response is validated before anything reads it", () => {
  const raw = { id: "t1", title: "x", status: "todo", createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-01-02T03:04:05Z" };
  assert.deepEqual(parseTask(raw), raw);
  assert.deepEqual(parseTasks([raw]), [raw]);
  assert.equal(
    code(() => parseTask({ ...raw, id: "" })),
    "MALFORMED_TASK",
  );
  assert.equal(
    code(() => parseTask({ ...raw, updatedAt: 17 })),
    "MALFORMED_TASK",
  );
  assert.equal(
    code(() => parseTask({ ...raw, status: "finished" })),
    "UNKNOWN_STATUS",
  );
  assert.equal(
    code(() => parseTask(null)),
    "MALFORMED_TASK",
  );
  assert.equal(
    code(() => parseTask([raw])),
    "MALFORMED_TASK",
  );
  assert.equal(
    code(() => parseTasks(raw)),
    "MALFORMED_TASK",
  );
});

test("a title is trimmed of the Unicode White_Space property, as the task services trim it", () => {
  // Built from code points: a formatter writes these escapes back as the invisible characters themselves.
  const [nel, bom] = [0x85, 0xfeff].map((cp) => String.fromCodePoint(cp));
  assert.equal(validateTitle(`${nel}a${nel}`), "a");
  assert.equal(validateTitle(`a${bom}`), `a${bom}`);
});
