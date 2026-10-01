/**
 * Builds a module's container image and proves it runs the way it is deployed. CI runs it; it needs
 * Docker, which local verify does not.
 *
 *   node scripts/probe-image.mjs <module> [--full-contract]
 *
 * The module's module.json says how, under `image`:
 * - "http": the image serves the task API and is held to scripts/contract/tasks-api.json. Started with
 *   no configuration, it must answer the contract's `ready` request on the port the contract states as
 *   the default, report every variable's default in its listening line, and, stopped as `docker stop`
 *   stops it, exit with the contract's `stopped.exitCode` within the default shutdown timeout. So the
 *   defaults are checked where they are used, and nothing binds that port on a developer's machine.
 * - {"run": command}: the module probes its image with its own command, in its directory. {image} is
 *   the tag built here, and {version} the version it was built as, which the build passes as
 *   --build-arg VERSION when the Dockerfile takes one.
 *
 * --full-contract also exercises every HTTP case and receive deadline against the running image.
 *
 * Exit 0 as expected · 1 the image behaved differently · 2 it could not be built or run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { presentModules, ROOT, run } from "./modules.mjs";

export const CONTRACT_FILE = join(ROOT, "scripts", "contract", "tasks-api.json");
/** What a probed image is built as: a version no release has, so it cannot be taken for one. */
export const PROBE_VERSION = "0.0.0-probe";
const READY_MS = 60_000;
// docker stop waits this long past the timeout before it kills: enough for a slow runner, and a killed
// container exits 137, so a service that ignored the signal still fails.
const STOP_MARGIN_S = 5;

const variables = (config) => Object.entries(config).filter(([name]) => !name.startsWith("$"));

/**
 * Where an image's first start disagrees with the contract, from its log and how it stopped. `logs` is
 * what `docker logs` printed; `exitCode` what `docker inspect` reported after `docker stop`.
 */
export function judgeImage({ config, startup }, { ready, logs, exitCode }) {
  const problems = [];
  if (!ready) problems.push(`it never answered ${startup.ready.method} ${startup.ready.path} with ${startup.ready.status} on the default port`);
  const lines = logs.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const listening = lines.find((line) => line?.level === startup.listening.level && line?.msg === startup.listening.msg);
  if (!listening) problems.push("it wrote no listening line");
  for (const [name, spec] of listening ? variables(config) : []) {
    if (listening[spec.reportedAs] !== spec.default.effective) {
      problems.push(`with ${name} unset it reports ${spec.reportedAs} ${JSON.stringify(listening[spec.reportedAs])}, expected the default ${spec.default.effective}`);
    }
  }
  if (exitCode !== startup.stopped.exitCode) problems.push(`sent ${startup.stopped.signal}, it exited ${exitCode}, expected ${startup.stopped.exitCode}`);
  return problems;
}

/** How long `docker stop` waits before it kills: the default shutdown timeout, in whole seconds, and a margin. */
export function stopSeconds({ config, startup }) {
  const within = config[startup.stopped.within];
  if (!within) throw new Error(`startup.stopped.within names ${startup.stopped.within}, which config does not state`);
  return Math.ceil(within.default.effective / 1000) + STOP_MARGIN_S;
}

const docker = (args, options = {}) => spawnSync("docker", args, { encoding: "utf8", ...options });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function answers(url, { method, status }) {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { method })).status === status) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function probeHttp(module, tag, fullContract = false) {
  const contract = JSON.parse(readFileSync(CONTRACT_FILE, "utf8"));
  const binding = variables(contract.config).find(([, spec]) => spec.binds);
  if (!binding) throw new Error("the contract states no variable that binds a port");
  const name = `probe-${module.id}-${process.pid}`;
  const host = await freePort();
  const started = docker(["run", "--detach", "--name", name, "--publish", `127.0.0.1:${host}:${binding[1].default.value}`, tag]);
  if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
  try {
    const ready = await answers(`http://127.0.0.1:${host}${contract.startup.ready.path}`, contract.startup.ready);
    const behavioral = [];
    if (ready && fullContract) {
      const { runCases, loadFacts, loadSpec, checkReceiveTimeouts } = await import("./check-contract.mjs");
      const base = `http://127.0.0.1:${host}`;
      behavioral.push(...await runCases(base, contract.cases, { facts: loadFacts(contract), spec: loadSpec() }));
      behavioral.push(...await checkReceiveTimeouts(base, contract.limits.receiveTimeoutsMs));
      console.log(`probe-image: ${contract.cases.length} HTTP cases and receive-timeout checks completed.`);
    }
    docker(["stop", "--time", String(stopSeconds(contract)), name]);
    const exitCode = Number(docker(["inspect", "--format", "{{.State.ExitCode}}", name]).stdout.trim());
    const logs = docker(["logs", name]);
    const problems = [...behavioral, ...judgeImage(contract, { ready, logs: `${logs.stdout}\n${logs.stderr}`, exitCode })];
    if (problems.length > 0) console.error(`${logs.stdout}${logs.stderr}`);
    return problems;
  } finally {
    docker(["rm", "--force", name], { stdio: "ignore" });
  }
}

async function main([id, option, ...extra]) {
  if ((option !== undefined && option !== "--full-contract") || extra.length) throw new Error("Usage: probe-image.mjs <module> [--full-contract]");
  const module = presentModules().find((m) => m.id === id);
  if (!module?.image) {
    console.error(`probe-image: ${id ?? "(none)"} is not a module present here with an image to probe.`);
    return 2;
  }
  const dir = join(ROOT, module.dir);
  const tag = `${module.id}:probe`;
  const takesVersion = /^\s*ARG\s+VERSION\b/m.test(readFileSync(join(dir, "Dockerfile"), "utf8"));
  const built = run("docker", ["build", ...(takesVersion ? ["--build-arg", `VERSION=${PROBE_VERSION}`] : []), "--tag", tag, "."], { cwd: dir });
  if (built.status !== 0) {
    console.error(`probe-image: ${module.id} did not build`);
    return 2;
  }
  if (module.image === "http") {
    const problems = await probeHttp(module, tag, option === "--full-contract");
    if (problems.length > 0) {
      console.error(`probe-image: the ${module.id} image differs from the contract:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    console.log(`probe-image: the ${module.id} image serves the contract's defaults and stops cleanly.`);
    return 0;
  }
  const [command, ...args] = module.image.run.map((part) => part.replaceAll("{image}", tag).replaceAll("{version}", PROBE_VERSION));
  const { status } = run(command, args, { cwd: dir });
  return status === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`probe-image: ${err.message}`);
      process.exitCode = 2;
    },
  );
}
