import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const module = (id, extra = {}) => ({ id, ...extra });

/** A throwaway tree with the named files, for fixtures a real runner has to read and run. */
const fixture = (files) => {
  const root = mkdtempSync(join(tmpdir(), "dev-runner-"));
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// A task service in miniature: it listens on PORT, answers anything, and can be told to exit.
const serve = `import { createServer } from "node:http";
const server = createServer((request, response) => {
  response.end("ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  console.log(\`listening on \${process.env.PORT}\`);
  if (process.env.EXIT_AFTER_MS !== undefined) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS));
});
`;
const manifest = (extra = {}) =>
  JSON.stringify({
    id: "fixture",
    toolchain: "node",
    checks: [{ name: "t", run: ["node", "--version"] }],
    ...extra,
  });

test("the stack is the task service and the modules that run alongside it", async () => {
  const { selectStack } = await import("../scripts/dev.mjs");
  const api = module("api-go", { dev: { run: ["go", "run", "./cmd/api"] }, taskApi: { run: ["go", "run", "./cmd/api"] } });
  const web = module("web", { dev: { run: ["npm", "run", "dev"] } });
  const library = module("ts-library", {});
  const stack = selectStack([api, web, library], {});
  assert.equal(stack.service, api);
  assert.deepEqual(stack.alongside, [web]);
});

test("with no module that runs in development, the runner says so", async () => {
  const { selectStack } = await import("../scripts/dev.mjs");
  assert.match(selectStack([module("ts-library", {})], {}).error, /no module here says how it runs in development/);
});

test("several task services need --api, and --api picks the named one", async () => {
  const { selectStack } = await import("../scripts/dev.mjs");
  const go = module("api-go", { dev: { run: [] }, taskApi: { run: [] } });
  const py = module("api-py", { dev: { run: [] }, taskApi: { run: [] } });
  assert.match(selectStack([go, py], {}).error, /pass --api with one of `api-go`, `api-py`/);
  assert.equal(selectStack([go, py], { api: "api-py" }).service, py);
  assert.match(selectStack([go, py], { api: "api-ts" }).error, /no task service named `api-ts`/);
});

test("--api with no task service at all is refused", async () => {
  const { selectStack } = await import("../scripts/dev.mjs");
  const web = module("web", { dev: { run: [] } });
  assert.match(selectStack([web], { api: "web" }).error, /none of `web` serves the task API/);
});

test("a stack with no task service runs the alongside modules alone", async () => {
  const { selectStack } = await import("../scripts/dev.mjs");
  const web = module("web", { dev: { run: [] } });
  const stack = selectStack([web], {});
  assert.equal(stack.service, null);
  assert.deepEqual(stack.alongside, [web]);
});

test("the runner takes --api, and nothing else", async () => {
  const { parseArgs } = await import("../scripts/dev.mjs");
  assert.deepEqual(parseArgs([]), { api: undefined });
  assert.deepEqual(parseArgs(["--api", "api-go"]), { api: "api-go" });
  assert.deepEqual(parseArgs(["--api=api-go"]), { api: "api-go" });
  assert.match(parseArgs(["--api"]).error, /--api needs a module id/);
  assert.match(parseArgs(["--api="]).error, /--api needs a module id/);
  assert.match(parseArgs(["--api", ""]).error, /--api needs a module id/);
  assert.match(parseArgs(["--port", "8080"]).error, /unknown argument `--port`/);
});

test("the port a task service listens on is the PORT set, or the contract's default", async () => {
  const { apiPort } = await import("../scripts/dev.mjs");
  assert.equal(await apiPort({ PORT: "3001" }), 3001);
  assert.equal(await apiPort({ PORT: "+8080" }), 8080);
  assert.equal(await apiPort({ PORT: "08080" }), 8080);
  assert.equal(await apiPort({ PORT: "0" }), null);
  assert.equal(await apiPort({ PORT: "-1" }), null);
  assert.equal(await apiPort({ PORT: "65536" }), null);
  assert.equal(await apiPort({ PORT: "8e3" }), null);
  assert.equal(await apiPort({ PORT: " 8080" }), null);
  assert.equal(await apiPort({}), 8080);
  assert.equal(await apiPort({ PORT: "" }), 8080);
});

test("a port answers once something listens on it, and not before", async () => {
  const { responds } = await import("../scripts/dev.mjs");
  const port = await freePort();
  assert.equal(await responds(port, "/healthz"), false);
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  assert.equal(await responds(port, "/healthz"), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await responds(port, "/healthz"), false);
});

test("a module that starts becomes ready, and stopping it takes the port back down", async () => {
  const { responds, startModule, stopModule, waitReady } = await import("../scripts/dev.mjs");
  const root = fixture({ "serve.mjs": serve });
  const port = await freePort();
  try {
    const running = startModule(
      { id: "fixture", dir: ".", dev: { run: ["node", "serve.mjs"] }, taskApi: { run: ["node", "serve.mjs"] } },
      { env: { ...process.env, PORT: String(port) }, root },
    );
    assert.deepEqual(await waitReady(running, { port, path: "/healthz" }), { ready: true, reason: null });
    await stopModule(running);
    assert.equal(await responds(port, "/healthz"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module that exits before answering is reported as exited, not kept waiting", async () => {
  const { startModule, stopModule, waitReady } = await import("../scripts/dev.mjs");
  const root = fixture({ "exit.mjs": "process.exit(3);\n" });
  const port = await freePort();
  try {
    const running = startModule({ id: "fixture", dir: ".", dev: { run: ["node", "exit.mjs"] } }, { root });
    assert.deepEqual(await waitReady(running, { port, timeoutMs: 10_000 }), { ready: false, reason: "exited" });
    assert.equal(running.child.exitCode, 3);
    await stopModule(running);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module that never answers is given up on at the deadline", async () => {
  const { startModule, stopModule, waitReady } = await import("../scripts/dev.mjs");
  const root = fixture({ "stay.mjs": "setInterval(() => {}, 1000);\n" });
  const port = await freePort();
  try {
    const running = startModule({ id: "fixture", dir: ".", dev: { run: ["node", "stay.mjs"] } }, { root });
    assert.deepEqual(await waitReady(running, { port, timeoutMs: 400 }), { ready: false, reason: "timeout" });
    await stopModule(running);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner starts the stack, waits for it, and ends when a member exits", async () => {
  const { main } = await import("../scripts/dev.mjs");
  const root = fixture({
    "svc/module.json": manifest({ dev: { run: ["node", "serve.mjs"] }, taskApi: { run: ["node", "serve.mjs"] } }),
    "svc/serve.mjs": serve,
  });
  const port = await freePort();
  const said = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => said.push(line);
  console.error = (line) => said.push(line);
  try {
    const code = await main([], { env: { ...process.env, PORT: String(port), EXIT_AFTER_MS: "1500" }, root });
    assert.equal(code, 1);
    assert.match(said.join("\n"), /dev: fixture ready: answering on port \d+\./);
    assert.match(said.join("\n"), /dev: fixture exited with code 0/);
  } finally {
    console.log = log;
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner refuses a checkout where nothing runs in development", async () => {
  const { main } = await import("../scripts/dev.mjs");
  const root = fixture({ "svc/module.json": manifest() });
  const said = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => said.push(line);
  console.error = (line) => said.push(line);
  try {
    assert.equal(await main([], { root }), 2);
    assert.match(said.join("\n"), /no module here says how it runs in development/);
  } finally {
    console.log = log;
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner refuses an argument it does not take", async () => {
  const { main } = await import("../scripts/dev.mjs");
  const root = fixture({ "svc/module.json": manifest() });
  const said = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => said.push(line);
  console.error = (line) => said.push(line);
  try {
    assert.equal(await main(["--port", "8080"], { root }), 2);
    assert.match(said.join("\n"), /unknown argument `--port`/);
  } finally {
    console.log = log;
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner refuses several task services without --api, and an unknown --api", async () => {
  const { main } = await import("../scripts/dev.mjs");
  const root = fixture({
    "api-a/module.json": manifest({ id: "api-a", dev: { run: ["node", "serve.mjs"] }, taskApi: { run: ["node", "serve.mjs"] } }),
    "api-b/module.json": manifest({ id: "api-b", dev: { run: ["node", "serve.mjs"] }, taskApi: { run: ["node", "serve.mjs"] } }),
    "serve.mjs": serve,
  });
  const said = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => said.push(line);
  console.error = (line) => said.push(line);
  try {
    assert.equal(await main([], { root }), 2);
    assert.match(said.join("\n"), /pass --api with one of `api-a`, `api-b`/);
    said.length = 0;
    assert.equal(await main(["--api", "api-c"], { root }), 2);
    assert.match(said.join("\n"), /no task service named `api-c`/);
  } finally {
    console.log = log;
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});
