/**
 * The server driven the way a client drives it: over a linked in-memory transport pair, through the
 * real protocol, with no process and no socket. A tool that is registered but unreachable — a bad
 * schema, a handler that throws — fails here and not in someone's editor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/adapters/mcp.ts";
import { GatewayError } from "../src/application/ports.ts";
import type { TaskGateway } from "../src/application/ports.ts";
import { MAX_TITLE_LENGTH, nextStatuses, STATUSES } from "../src/domain/task.ts";
import { fakeGateway, task } from "./fake-gateway.ts";

const VERSION = "1.2.3-test";

interface ToolCall {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

async function connect(t: { after: (fn: () => Promise<void>) => void }, gateway: TaskGateway): Promise<Client> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const server = createServer(gateway, { version: VERSION });
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await server.connect(serverEnd);
  await client.connect(clientEnd);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const said = (result: unknown): string => (result as ToolCall).content.map((part) => part.text ?? "").join("\n");
const failed = (result: unknown): boolean => (result as ToolCall).isError === true;

test("every tool is advertised with a schema a client can read", async (t) => {
  const client = await connect(t, fakeGateway());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["create_task", "get_task", "list_tasks", "move_task"]);
  const move = tools.find((tool) => tool.name === "move_task");
  assert.deepEqual(move?.inputSchema.required, ["id", "status"]);
  assert.ok(
    tools.every((tool) => (tool.description ?? "") !== ""),
    "a tool with no description cannot be chosen",
  );
  assert.ok(
    tools.every((tool) => tool.outputSchema?.type === "object"),
    "every tool declares what its structured result holds",
  );
});

test("each tool tells a client whether it only reads", async (t) => {
  const { tools } = await (await connect(t, fakeGateway())).listTools();
  const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  assert.equal(hints["list_tasks"]?.readOnlyHint, true);
  assert.equal(hints["get_task"]?.readOnlyHint, true);
  for (const name of ["create_task", "move_task"]) {
    assert.equal(hints[name]?.readOnlyHint, false, name);
    assert.equal(hints[name]?.idempotentHint, false, name);
  }
  assert.ok(
    tools.every((tool) => tool.annotations?.destructiveHint === false),
    "no tool here deletes anything",
  );
});

test("every result carries structured content that says what the text says", async (t) => {
  const client = await connect(t, fakeGateway());
  const structured = (result: unknown) => (result as { structuredContent?: Record<string, unknown> }).structuredContent;

  assert.deepEqual(structured(await client.callTool({ name: "list_tasks", arguments: {} })), { tasks: [] });
  const created = structured(await client.callTool({ name: "create_task", arguments: { title: "Write the README" } }));
  assert.deepEqual(created?.["task"], {
    id: "t1",
    title: "Write the README",
    status: "todo",
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-01-02T03:04:05Z",
    nextStatuses: ["in_progress"],
  });
  const moved = structured(await client.callTool({ name: "move_task", arguments: { id: "t1", status: "in_progress" } }));
  assert.deepEqual((moved?.["task"] as { nextStatuses?: string[] } | undefined)?.nextStatuses, ["todo", "done"]);
  const listed = structured(await client.callTool({ name: "list_tasks", arguments: {} }));
  assert.equal((listed?.["tasks"] as unknown[] | undefined)?.length, 1);
});

test("get_task answers with one task, and names an unknown id as NOT_FOUND", async (t) => {
  const client = await connect(t, fakeGateway([task({ id: "t1", status: "in_progress" })]));
  const found = await client.callTool({ name: "get_task", arguments: { id: "t1" } });
  assert.equal(failed(found), false);
  assert.match(said(found), /t1 {2}in_progress .*moves from here: todo, done/);

  const missing = await client.callTool({ name: "get_task", arguments: { id: "t9" } });
  assert.equal(failed(missing), true);
  assert.match(said(missing), /NOT_FOUND: no task with id "t9"; list_tasks names every task/);
});

test("the tools create, list and move a task", async (t) => {
  const gateway = fakeGateway();
  const client = await connect(t, gateway);

  assert.match(said(await client.callTool({ name: "list_tasks", arguments: {} })), /No tasks yet/);

  const created = await client.callTool({ name: "create_task", arguments: { title: "Write the README" } });
  assert.equal(failed(created), false);
  assert.match(said(created), /Created t1 {2}todo .*Write the README/);

  const listed = said(await client.callTool({ name: "list_tasks", arguments: {} }));
  assert.match(listed, /moves from here: in_progress/);

  const moved = await client.callTool({ name: "move_task", arguments: { id: "t1", status: "in_progress" } });
  assert.match(said(moved), /Moved t1 {2}in_progress .*moves from here: todo, done/);
});

test("a broken rule comes back as a tool error the model can read, not a protocol error", async (t) => {
  const client = await connect(t, fakeGateway([task({ id: "t1", status: "todo" })]));

  const illegal = await client.callTool({ name: "move_task", arguments: { id: "t1", status: "done" } });
  assert.equal(failed(illegal), true);
  assert.match(said(illegal), /INVALID_TRANSITION.*legal moves from todo: in_progress/);

  const missing = await client.callTool({ name: "move_task", arguments: { id: "t9", status: "in_progress" } });
  assert.equal(failed(missing), true);
  assert.match(said(missing), /NOT_FOUND/);

  const empty = await client.callTool({ name: "create_task", arguments: { title: "   " } });
  assert.equal(failed(empty), true);
  assert.match(said(empty), /EMPTY_TITLE/);
});

test("input the schema rejects never reaches the handler", async (t) => {
  const client = await connect(t, fakeGateway());
  const wrong = await client.callTool({ name: "move_task", arguments: { id: "t1", status: "archived" } });
  assert.equal(failed(wrong), true);
});

test("an API that cannot answer is reported with what was tried", async (t) => {
  const unreachable: TaskGateway = {
    async list() {
      throw new GatewayError("GET http://localhost:8080/api/tasks failed: no answer within 10000 ms");
    },
    async find() {
      throw new GatewayError("unused");
    },
    async create() {
      throw new GatewayError("unused");
    },
    async move() {
      throw new GatewayError("unused");
    },
  };
  const client = await connect(t, unreachable);
  const result = await client.callTool({ name: "list_tasks", arguments: {} });
  assert.equal(failed(result), true);
  assert.match(said(result), /no answer within 10000 ms/);
});

test("the server reports the version it was built as", async (t) => {
  assert.equal((await connect(t, fakeGateway())).getServerVersion()?.version, VERSION);
});

test("the descriptions state the rules as the domain does: every legal move, and the first status", async (t) => {
  const { tools } = await (await connect(t, fakeGateway())).listTools();
  const move = tools.find((tool) => tool.name === "move_task")?.description ?? "";
  const named = [...move.matchAll(/(\w+) → (\w+)/g)].map(([, from, to]) => `${from} → ${to}`).sort();
  const legal = STATUSES.flatMap((from) => nextStatuses(from).map((to) => `${from} → ${to}`)).sort();
  assert.deepEqual(named, legal);
  assert.match(tools.find((tool) => tool.name === "create_task")?.description ?? "", new RegExp(`starts in the ${STATUSES[0]} status`));
});

test("the longest title is taken in any script, however many UTF-16 units it is", async (t) => {
  const client = await connect(t, fakeGateway());
  // 200 astral characters are 400 UTF-16 units, where a schema's maxLength counts; the rules count code points.
  const longest = "🙂".repeat(MAX_TITLE_LENGTH);
  const created = await client.callTool({ name: "create_task", arguments: { title: ` ${longest} ` } });
  assert.equal(failed(created), false, said(created));
});
