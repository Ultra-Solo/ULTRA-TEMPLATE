import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createHandler } from "../src/adapters/http.ts";
import { MemoryTaskRepository } from "../src/adapters/memory-task-repository.ts";
import { TaskService } from "../src/application/task-service.ts";

async function start(t: TestContext): Promise<string> {
  const service = new TaskService({
    repository: new MemoryTaskRepository(),
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => "id-1" },
  });
  const server = createServer(createHandler(service, () => {}));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const call = async (base: string, method: string, path: string, body?: string) => {
  const res = await fetch(base + path, body === undefined ? { method } : { method, body });
  return { status: res.status, body: await res.text() };
};

test("a task goes through its lifecycle", async (t) => {
  const base = await start(t);
  assert.equal((await call(base, "POST", "/api/tasks", '{"title":"ship it"}')).status, 201);
  const list = await call(base, "GET", "/api/tasks");
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.body)[0].status, "todo");
  assert.equal((await call(base, "PATCH", "/api/tasks/id-1/status", '{"status":"done"}')).status, 409);
  assert.equal((await call(base, "PATCH", "/api/tasks/id-1/status", '{"status":"in_progress"}')).status, 200);
});

test("requests are validated at the boundary, with the same status codes as api-go", async (t) => {
  const base = await start(t);
  const cases: [string, string, string, string | undefined, number][] = [
    ["health", "GET", "/healthz", undefined, 200],
    ["HEAD like GET", "HEAD", "/healthz", undefined, 200],
    ["blank title", "POST", "/api/tasks", '{"title":" "}', 422],
    // null reads as empty, as in api-go and api-py and as a null status already did.
    ["null title", "POST", "/api/tasks", '{"title":null}', 422],
    ["unknown field", "POST", "/api/tasks", '{"title":"x","admin":true}', 400],
    ["not JSON", "POST", "/api/tasks", "title=x", 400],
    ["null body", "POST", "/api/tasks", "null", 400],
    ["data after the object", "POST", "/api/tasks", '{"title":"x"} junk', 400],
    ["two objects", "POST", "/api/tasks", '{"title":"x"}{"title":"y"}', 400],
    ["oversized body", "POST", "/api/tasks", `{"title":"${"x".repeat(2 * 1024 * 1024)}"}`, 400],
    ["unknown status", "PATCH", "/api/tasks/id-1/status", '{"status":"DONE"}', 422],
    ["missing task", "GET", "/api/tasks/nope", undefined, 404],
    ["wrong method", "DELETE", "/api/tasks", undefined, 405],
  ];
  for (const [name, method, path, body, want] of cases) {
    assert.equal((await call(base, method, path, body)).status, want, name);
  }
});

test("a wrong method is answered 405 with the methods the path allows, HEAD wherever GET is", async (t) => {
  const base = await start(t);
  const cases: [string, string, string][] = [
    ["POST", "/healthz", "GET, HEAD"],
    ["DELETE", "/api/tasks", "GET, HEAD, POST"],
    ["PUT", "/api/tasks/id-1", "GET, HEAD"],
    ["GET", "/api/tasks/id-1/status", "PATCH"],
  ];
  for (const [method, path, allow] of cases) {
    const res = await fetch(base + path, { method });
    assert.deepEqual([res.status, res.headers.get("allow")], [405, allow], `${method} ${path}`);
  }
});
