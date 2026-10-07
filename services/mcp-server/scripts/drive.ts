/**
 * Drives this server the way a client does — over stdio and over HTTP, through the real protocol, with
 * the SDK's own client — where the tests cannot reach: the built image, and a real task API.
 *
 *   node scripts/drive.ts probe <version> -- <command...>   # e.g. -- docker run --rm -i mcp-server:ci
 *   node scripts/drive.ts e2e <task-api-url>                # this server, from source, against a real API
 *
 * `probe` connects to whatever the command starts, checks that it reports <version> and speaks the newest
 * protocol version this SDK knows, and lists its tools; the protocol version is the SDK's, never written
 * here. `e2e` starts `node src/main.ts` against the task API, walks every tool over stdio, then starts it
 * again with MCP_TRANSPORT=http and walks the same tools over a real socket: it creates a task, walks it
 * through every legal move the domain states, then tries a move the rules refuse and an unknown id.
 * The fake gateway in the tests cannot notice the API answering in a shape the gateway misreads; this can.
 *
 * Exit 0 as expected · 1 the server answered differently · 2 it could not be run.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client, LATEST_PROTOCOL_VERSION, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_HTTP_PATH } from "../src/adapters/http-serve.ts";
import { nextStatuses, STATUSES, type Status } from "../src/domain/task.ts";

class Mismatch extends Error {}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Mismatch(message);
}

interface Answer {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

interface TaskView {
  id: string;
  title: string;
  status: Status;
  nextStatuses: Status[];
}

/** Starts `command` and connects to it over its stdin and stdout, with `env` as its environment. */
async function connect(command: string, args: string[], env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "drive", version: "0.0.0" });
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  await client.connect(new StdioClientTransport({ command, args, cwd, env, stderr: "inherit" }));
  return client;
}

// The caller's whole environment, for a command such as docker that reads its own configuration from it.
const inherited = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? (result.content as { text?: string }[]) : [];
  return {
    isError: result.isError === true,
    text: content.map((part) => part.text ?? "").join("\n"),
    structured: result.structuredContent as Record<string, unknown> | undefined,
  };
}

/** The task a tool answered with, checked for the fields and the moves its status allows. */
function taskOf(answer: Answer, what: string): TaskView {
  expect(!answer.isError, `${what} failed: ${answer.text}`);
  const task = answer.structured?.["task"] as TaskView | undefined;
  expect(typeof task?.id === "string" && typeof task.title === "string", `${what} answered no task: ${JSON.stringify(answer.structured)}`);
  expect(
    STATUSES.includes(task.status),
    `${what} answered the status ${JSON.stringify(task.status)}, which is not one of ${STATUSES.join(", ")}`,
  );
  const allowed = [...nextStatuses(task.status)];
  expect(
    JSON.stringify(task.nextStatuses) === JSON.stringify(allowed),
    `${what}: the moves from ${task.status} are ${JSON.stringify(task.nextStatuses)}, expected ${JSON.stringify(allowed)}`,
  );
  return task;
}

/** Uses every tool through a connected client: creates a task, walks every legal move the domain states, then tries a move the rules refuse and an unknown id. */
async function walk(client: Client, apiUrl: string, transport: string): Promise<void> {
  let task = taskOf(await call(client, "create_task", { title: "end to end" }), "create_task");
  expect(task.status === STATUSES[0], `a new task is ${task.status}, expected ${STATUSES[0]}`);
  const got = taskOf(await call(client, "get_task", { id: task.id }), "get_task");
  expect(got.id === task.id && got.title === task.title, `get_task answered ${JSON.stringify(got)} for ${JSON.stringify(task)}`);
  const listed = (await call(client, "list_tasks", {})).structured?.["tasks"];
  expect(
    Array.isArray(listed) && listed.some((item) => (item as TaskView).id === task.id),
    `list_tasks does not list the task it created: ${JSON.stringify(listed)}`,
  );

  // Walk every legal move at least once: an untried one from here when there is one, else the first.
  const untried = new Set(STATUSES.flatMap((from) => nextStatuses(from).map((to) => `${from} → ${to}`)));
  for (let step = 0; untried.size > 0 && step < STATUSES.length * STATUSES.length * 2; step++) {
    const options = nextStatuses(task.status);
    const to = options.find((status) => untried.has(`${task.status} → ${status}`)) ?? options[0];
    if (to === undefined) break;
    untried.delete(`${task.status} → ${to}`);
    const moved = taskOf(await call(client, "move_task", { id: task.id, status: to }), `move_task ${task.status} → ${to}`);
    expect(moved.status === to, `move_task to ${to} left the task ${moved.status}`);
    task = moved;
  }
  expect(untried.size === 0, `the walk never reached ${[...untried].join(", ")}`);

  const refused = STATUSES.find((status) => !nextStatuses(task.status).includes(status));
  if (refused !== undefined) {
    const answer = await call(client, "move_task", { id: task.id, status: refused });
    expect(answer.isError, `move_task ${task.status} → ${refused} is not a legal move, yet it answered ${answer.text}`);
  }
  const missing = await call(client, "get_task", { id: "no-such-task" });
  expect(missing.isError, `get_task for an unknown id answered ${missing.text}`);
  console.log(`drive: every tool works against ${apiUrl} over ${transport}, and every legal move was made`);
}

async function e2e(apiUrl: string): Promise<void> {
  // The SDK's safe subset of the environment, so nothing set in the caller's shell changes the server.
  const stdio = await connect(process.execPath, ["src/main.ts"], { ...getDefaultEnvironment(), TASK_API_URL: apiUrl });
  try {
    await walk(stdio, apiUrl, "stdio");
  } finally {
    await stdio.close();
  }

  // The same walk over the transport a client that cannot start a subprocess connects to. The port
  // comes from the line the server prints when it listens — port 0 asked the operating system for one.
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd,
    env: { ...getDefaultEnvironment(), TASK_API_URL: apiUrl, MCP_TRANSPORT: "http", MCP_HTTP_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const said: Buffer[] = [];
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the http server said no port within 10 s: ${Buffer.concat(said).toString()}`)),
        10_000,
      );
      const onExit = () => reject(new Error(`the http server exited before it listened: ${Buffer.concat(said).toString()}`));
      // A line can arrive split across chunks, so the whole of stderr is searched each time.
      child.stderr.on("data", (chunk: Buffer) => {
        said.push(chunk);
        const found = /over http on port (\d+)/.exec(Buffer.concat(said).toString());
        if (found) {
          clearTimeout(timer);
          child.off("exit", onExit);
          resolve(Number(found[1]));
        }
      });
      child.on("exit", onExit);
    });
    const client = new Client({ name: "drive", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}${MCP_HTTP_PATH}`)));
    try {
      await walk(client, apiUrl, "http");
    } finally {
      await client.close();
    }
  } finally {
    child.kill();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the http server did not exit after SIGTERM")), 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function probe(version: string, [command, ...args]: string[]): Promise<void> {
  expect(command !== undefined, "probe needs the command that starts the server, after --");
  const client = await connect(command, args, inherited());
  try {
    const info = client.getServerVersion();
    expect(info?.version === version, `the server reports version ${JSON.stringify(info?.version)}, expected ${version}`);
    const protocol = client.getNegotiatedProtocolVersion();
    expect(
      protocol === LATEST_PROTOCOL_VERSION,
      `the server speaks protocol version ${protocol}, where this SDK's newest is ${LATEST_PROTOCOL_VERSION}`,
    );
    const { tools } = await client.listTools();
    expect(tools.length > 0, "the server lists no tools");
    console.log(`drive: ${info.name} ${info.version} speaks MCP ${protocol} and lists ${tools.length} tools`);
  } finally {
    await client.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "e2e" && rest.length === 1 && rest[0]) return e2e(rest[0]);
  const split = rest.indexOf("--");
  if (verb === "probe" && split === 1 && rest[0]) return probe(rest[0], rest.slice(2));
  throw new Error("usage: drive.ts e2e <task-api-url> | drive.ts probe <version> -- <command...>");
}

main(process.argv.slice(2)).then(
  () => {
    process.exitCode = 0;
  },
  (err: unknown) => {
    console.error(`drive: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = err instanceof Mismatch ? 1 : 2;
  },
);
