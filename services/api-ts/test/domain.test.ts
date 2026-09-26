import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask, DomainError, MAX_TITLE_LENGTH, parseStatus, transition, type Status } from "../src/domain/task.ts";

const NOW = "2026-01-02T03:04:05.000Z";
const LATER = "2026-01-02T03:05:05.000Z";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DomainError ? err.code : "not a DomainError";
  }
};

test("createTask trims the title and starts in todo", () => {
  assert.deepEqual(createTask("id-1", "  write docs  ", NOW), {
    id: "id-1",
    title: "write docs",
    status: "todo",
    createdAt: NOW,
    updatedAt: NOW,
  });
});

test("createTask counts characters, not UTF-16 units", () => {
  const longest = "😀".repeat(MAX_TITLE_LENGTH);
  assert.equal(createTask("id-1", longest, NOW).title, longest);
  assert.equal(
    code(() => createTask("id-1", `${longest}😀`, NOW)),
    "TITLE_TOO_LONG",
  );
  assert.equal(
    code(() => createTask("id-1", "   ", NOW)),
    "EMPTY_TITLE",
  );
});

test("transition allows exactly the documented moves", () => {
  const moves: [Status, Status, boolean][] = [
    ["todo", "in_progress", true],
    ["todo", "done", false],
    ["todo", "todo", false],
    ["in_progress", "done", true],
    ["in_progress", "todo", true],
    ["done", "todo", false],
    ["done", "in_progress", false],
  ];
  for (const [from, to, allowed] of moves) {
    const task = { ...createTask("id-1", "x", NOW), status: from };
    if (allowed) assert.deepEqual(transition(task, to, LATER), { ...task, status: to, updatedAt: LATER });
    else
      assert.equal(
        code(() => transition(task, to, LATER)),
        "INVALID_TRANSITION",
        `${from} to ${to}`,
      );
  }
});

test("parseStatus accepts only the known statuses", () => {
  assert.equal(parseStatus("in_progress"), "in_progress");
  for (const bad of ["DONE", "", undefined, 3])
    assert.equal(
      code(() => parseStatus(bad)),
      "UNKNOWN_STATUS",
    );
});

test("createTask trims the Unicode White_Space property, and keeps what JavaScript's trim would also take", () => {
  // Built from code points: a formatter writes these escapes back as the invisible characters themselves.
  const [nel, ideographicSpace, paragraphSeparator, nbsp, bom] = [0x85, 0x3000, 0x2029, 0xa0, 0xfeff].map((cp) => String.fromCodePoint(cp));
  // U+0085 is White_Space but not trimmed by String.prototype.trim; U+FEFF is trimmed by it but is not White_Space.
  assert.equal(createTask("id-1", `${nel}${ideographicSpace}a${paragraphSeparator}`, NOW).title, "a");
  assert.equal(createTask("id-1", `\u001fa${bom}`, NOW).title, `\u001fa${bom}`);
  assert.equal(
    code(() => createTask("id-1", `${nel}${nbsp}`, NOW)),
    "EMPTY_TITLE",
  );
});
