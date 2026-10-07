/**
 * The HTTP transport driven the way a client drives it: a real MCP client over a real socket
 * against the real handler, on a port the operating system assigned. What is proved here is the
 * bridge — Node's streams to the web-standard request and response the SDK speaks — and that
 * stateless serving keeps every tool the stdio transport serves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, LATEST_PROTOCOL_VERSION, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_HTTP_PATH, serveHttp, type HttpServeHandle } from "../src/adapters/http-serve.ts";
import { createServer } from "../src/adapters/mcp.ts";
import { GatewayError } from "../src/application/ports.ts";
import type { TaskGateway } from "../src/application/ports.ts";
import { fakeGateway, task } from "./fake-gateway.ts";

const VERSION = "1.2.3-test";

interface ToolCall {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

interface Connected {
  readonly client: Client;
  readonly handle: HttpServeHandle;
}

async function connect(t: { after: (fn: () => Promise<void>) => void }, gateway: TaskGateway): Promise<Connected> {
  const handle = await serveHttp({
    port: 0,
    makeServer: () => createServer(gateway, { version: VERSION }),
    onError: () => {},
  });
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${handle.port}${MCP_HTTP_PATH}`)));
  t.after(async () => {
    await client.close();
    await handle.close();
  });
  return { client, handle };
}

const said = (result: unknown): string => (result as ToolCall).content.map((part) => part.text ?? "").join("\n");
const failed = (result: unknown): boolean => (result as ToolCall).isError === true;

test("port 0 asks the operating system for a port, and the handle reports the one it took", async (t) => {
  const { handle } = await connect(t, fakeGateway());
  assert.ok(handle.port > 0);
});

test("the client connects, and every tool is advertised as over stdio", async (t) => {
  const { client } = await connect(t, fakeGateway());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["create_task", "get_task", "list_tasks", "move_task"]);
  assert.equal(client.getServerVersion()?.version, VERSION);
});

test("the tools create, list and move a task over the socket", async (t) => {
  const { client } = await connect(t, fakeGateway());

  const created = await client.callTool({ name: "create_task", arguments: { title: "Write the README" } });
  assert.equal(failed(created), false);
  assert.match(said(created), /Created t1 {2}todo .*Write the README/);
  assert.deepEqual((created as { structuredContent?: Record<string, unknown> }).structuredContent?.["task"], {
    id: "t1",
    title: "Write the README",
    status: "todo",
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-01-02T03:04:05Z",
    nextStatuses: ["in_progress"],
  });

  const moved = await client.callTool({ name: "move_task", arguments: { id: "t1", status: "in_progress" } });
  assert.match(said(moved), /Moved t1 {2}in_progress .*moves from here: todo, done/);

  const listed = said(await client.callTool({ name: "list_tasks", arguments: {} }));
  assert.match(listed, /in_progress .*Write the README/);
});

test("a broken rule comes back as a tool error the model can read, not a protocol error", async (t) => {
  const { client } = await connect(t, fakeGateway([task({ id: "t1", status: "todo" })]));
  const illegal = await client.callTool({ name: "move_task", arguments: { id: "t1", status: "done" } });
  assert.equal(failed(illegal), true);
  assert.match(said(illegal), /INVALID_TRANSITION.*legal moves from todo: in_progress/);
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
  const { client } = await connect(t, unreachable);
  const result = await client.callTool({ name: "list_tasks", arguments: {} });
  assert.equal(failed(result), true);
  assert.match(said(result), /no answer within 10000 ms/);
});

test("a request for any other path is answered 404, not by the handler", async (t) => {
  const { handle } = await connect(t, fakeGateway());
  const response = await fetch(`http://localhost:${handle.port}/`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), new RegExp(`The MCP endpoint is ${MCP_HTTP_PATH}`));
});

test("stateless serving refuses the session operations: GET is answered 405", async (t) => {
  const { handle } = await connect(t, fakeGateway());
  const response = await fetch(`http://localhost:${handle.port}${MCP_HTTP_PATH}`);
  assert.equal(response.status, 405);
  await response.body?.cancel();
});

test("an initialize response carries no session id: nothing is held between requests", async (t) => {
  const { handle } = await connect(t, fakeGateway());
  const response = await fetch(`http://localhost:${handle.port}${MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "raw-probe", version: "0.0.0" },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  await response.text();
});

test("after close the port is gone", async (t) => {
  const { client, handle } = await connect(t, fakeGateway());
  await client.close();
  await handle.close();
  await assert.rejects(() => fetch(`http://localhost:${handle.port}${MCP_HTTP_PATH}`));
});
