import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryTaskRepository } from "../src/adapters/memory-task-repository.ts";
import type { TaskRepository } from "../src/application/ports.ts";
import type { Task } from "../src/domain/task.ts";
import { checkTaskRepository } from "./task-repository-conformance.ts";

test("the in-memory store keeps the storage port's contract", async () => {
  assert.deepEqual(await checkTaskRepository(() => new MemoryTaskRepository()), []);
});

// A store with the mistakes a new adapter makes: newest first, one list every instance shares, and a
// replace that does not check the task is still the one the caller read.
const shared: Task[] = [];
const broken = (): TaskRepository => ({
  save: async (task) => {
    shared.unshift(task);
  },
  get: async (id) => shared.find((task) => task.id === id),
  list: async () => shared,
  replace: async (task) => {
    shared.unshift(task);
    return true;
  },
});

test("the suite fails a broken store, naming each way it breaks the contract", async () => {
  const problems = (await checkTaskRepository(broken)).join("\n");
  for (const expected of [
    "listed oldest first",
    "two stores share nothing",
    "an empty store lists nothing",
    "a replace from a task that is out of date is refused",
    "a replace of a task never saved is refused",
  ]) {
    assert.ok(problems.includes(expected), `not reported: ${expected}\n${problems}`);
  }
});
