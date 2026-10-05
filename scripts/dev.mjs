/**
 * The development runner: one command that starts this checkout's development stack — the task
 * service, and every module that runs alongside it — waits until each answers, streams their
 * output with a prefix, and stops them all as one tree.
 *
 * Which modules run is not listed here: a module runs in development when its `module.json`
 * carries a `dev` key, and the task services all listen on the port the task API contract names,
 * so when several are present one must be chosen with `--api <id>` (ADR-0027).
 *
 *   node scripts/dev.mjs                  # the only task service, and the modules alongside it
 *   node scripts/dev.mjs --api api-go     # which task service, when several are present
 */
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ModuleError, presentModules, ROOT } from "./modules.mjs";

/** Vite's own default port; the manifest's `--strictPort` makes Vite exit rather than move to another, so this is the port it binds or dies trying. */
const WEB_DEV_PORT = 5173;

/** The arguments the runner takes: `--api <id>` or `--api=<id>`, and nothing else. */
export function parseArgs(argv) {
  let api;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--api") {
      if (index + 1 >= argv.length) return { error: "--api needs a module id" };
      api = argv[++index];
    } else if (argv[index].startsWith("--api=")) {
      api = argv[index].slice("--api=".length);
    } else {
      return { error: `unknown argument \`${argv[index]}\`; only --api <id> is understood` };
    }
  }
  if (api === "") return { error: "--api needs a module id" };
  return { api };
}

/**
 * The stack to run: the task service `api` names (or the only one) and every module that runs in
 * development without serving the task API, or the reason there is no such stack.
 */
export function selectStack(modules, { api } = {}) {
  const runnable = modules.filter((module) => module.dev !== undefined);
  if (runnable.length === 0) {
    return { error: "no module here says how it runs in development: no module.json carries a `dev` key" };
  }
  const services = runnable.filter((module) => module.taskApi !== undefined);
  const alongside = runnable.filter((module) => module.taskApi === undefined);
  const ids = (list) => list.map((module) => `\`${module.id}\``).join(", ");
  if (api !== undefined) {
    if (services.length === 0) return { error: `--api names a task service, but none of ${ids(runnable)} serves the task API` };
    const named = services.find((module) => module.id === api);
    if (named === undefined) return { error: `no task service named \`${api}\`: the task services that can run are ${ids(services)}` };
    return { service: named, alongside };
  }
  if (services.length > 1) {
    return { error: `several task services can run, and all listen on the same port; pass --api with one of ${ids(services)}` };
  }
  return { service: services[0] ?? null, alongside };
}

/**
 * The port a task service listens on: the `PORT` the environment sets, or the contract's default.
 * The digits-only reading mirrors what the services themselves accept, so a `PORT` they would
 * refuse is no port to wait on here either — the service says why it refused, in its own output.
 *
 * The contract is read through `scripts/check-contract.mjs`, which ships only with the task
 * services — the only modules that ever reach this default — so the import is made here, not at
 * the top, where it would break a checkout that has none of them.
 */
export async function apiPort(env = process.env) {
  const stated =
    env.PORT !== undefined && env.PORT !== "" ? env.PORT : (await import("./check-contract.mjs")).loadContract().config.PORT.default.value;
  if (!/^\+?[0-9]+$/.test(stated)) return null;
  const port = Number(stated);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Whether anything answers an HTTP request on the port: any response means the listener is up.
 * The task services are contracted to answer on 127.0.0.1; a dev server like Vite binds
 * `localhost`, which can be ::1 alone, so alongside modules are probed there instead.
 */
export function responds(port, path = "/", timeoutMs = 2_000, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = request({ host, port, method: "GET", path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a module's `dev` command and returns what is needed to watch and stop it: the child, its
 * lines so far, and a promise that settles when it closes.
 *
 * On Windows `npm` is a .cmd shim that only a shell can start, so the command goes through one
 * there, joined into a single string: every argument a manifest states is a plain token, which is
 * what makes that safe. Everywhere else the child starts detached, in a process group of its own,
 * so `uv`'s python and `npm`'s vite stop as one tree.
 */
export function startModule(module, { env = process.env, root = ROOT, onLine = () => {} } = {}) {
  const [command, ...args] = module.dev.run;
  const child =
    process.platform === "win32"
      ? spawn([command, ...args].join(" "), {
          cwd: join(root, module.dir),
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
        })
      : spawn(command, args, {
          cwd: join(root, module.dir),
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      onLine(module.id, line);
    });
  }
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return { module, child, lines, closed };
}

/** Stops a started module and everything it started, and resolves once it is gone. */
export async function stopModule(running) {
  const { child, closed } = running;
  if (!exited(child)) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone; the close event below settles it
      }
    }
  }
  const force = setTimeout(() => {
    if (process.platform !== "win32" && !exited(child)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 5_000);
  await closed;
  clearTimeout(force);
}

/**
 * Waits until the module answers on the port, or the deadline passes, or the child exits first —
 * a child that exits before answering is the stack's own diagnosis, so its exit wins.
 */
export async function waitReady(running, { port, path = "/", host = "127.0.0.1", timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited(running.child)) return { ready: false, reason: "exited" };
    if (port !== null && (await responds(port, path, 2_000, host))) return { ready: true, reason: null };
    if (Date.now() >= deadline) return { ready: false, reason: "timeout" };
    await pause(intervalMs);
  }
}

function reportExit(running) {
  const how = running.child.signalCode !== null ? `signal ${running.child.signalCode}` : `code ${running.child.exitCode}`;
  console.error(`dev: ${running.module.id} exited with ${how}; its last lines:`);
  for (const line of running.lines.slice(-40)) console.error(`  ${line}`);
}

/**
 * Runs the development stack until a member exits or the runner is interrupted. The service starts
 * first — the web dev server proxies `/api` to it — every member's readiness is waited for in that
 * order, and the exit code says what happened: 0 is never returned, because a dev stack that ends
 * ended by something going away.
 */
export async function main(argv = process.argv.slice(2), { env = process.env, root = ROOT } = {}) {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    console.error(`dev: ${args.error}`);
    return 2;
  }
  let modules;
  try {
    modules = presentModules(root);
  } catch (err) {
    if (err instanceof ModuleError) {
      console.error(`dev: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const stack = selectStack(modules, { api: args.api });
  if (stack.error !== undefined) {
    console.error(`dev: ${stack.error}`);
    return 2;
  }
  const started = [];
  const stopAll = async () => {
    await Promise.all(started.map((running) => stopModule(running)));
  };
  process.once("SIGINT", () => {
    void stopAll().then(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void stopAll().then(() => process.exit(143));
  });
  const say = (id, line) => console.log(`[${id}] ${line}`);
  const members = stack.service === null ? [...stack.alongside] : [stack.service, ...stack.alongside];
  for (const module of members) started.push(startModule(module, { env, root, onLine: say }));
  const port = stack.service === null ? null : await apiPort(env);
  for (const running of started) {
    const isService = running.module.taskApi !== undefined;
    const outcome = await waitReady(running, isService ? { port, path: "/healthz" } : { port: WEB_DEV_PORT, host: "localhost" });
    if (outcome.ready) {
      console.log(`dev: ${running.module.id} ready: answering on port ${isService ? port : WEB_DEV_PORT}.`);
      continue;
    }
    if (outcome.reason === "exited" || isService) {
      reportExit(running);
      await stopAll();
      return 1;
    }
    console.log(`dev: ${running.module.id} has not answered on port ${WEB_DEV_PORT} yet; its logs above say where it is.`);
  }
  console.log("dev: Ctrl-C stops every process.");
  const first = await Promise.race(started.map((running) => running.closed.then(() => running)));
  reportExit(first);
  await stopAll();
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
