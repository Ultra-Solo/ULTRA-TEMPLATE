/**
 * The browser smoke test: the app as it ships, served by `vite preview`, driven by a real Chromium
 * against a real task API — where the component tests, with `fetch` stubbed in happy-dom, cannot reach.
 *
 *   node scripts/e2e.ts <task-api-url>
 *
 * Builds the app, serves the production bundle on a free port with `/api` pointed at the task API
 * (`TASK_API`, read by vite.config.ts), and walks the journey ADR-0025 names: create a task by
 * keyboard, move it by click, reload and see it persist, then a title one character over the
 * contract's longest and the board's alert showing the API's reason. A Playwright trace is written
 * to `test-results/` when any step fails; its path is printed.
 *
 * Chromium is Playwright's own, pinned by the lockfile and installed when missing, so the same
 * binary runs here and in CI. Exit 0 the journey passed · 1 a step failed · 2 it could not run.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const PLAYWRIGHT = join(ROOT, "node_modules", "playwright", "cli.js");
const TRACE = join(ROOT, "test-results", "e2e-trace.zip");

class Mismatch extends Error {}
class CouldNotRun extends Error {}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Mismatch(message);
}

/** Runs a command here in the module and returns its exit status, with its output shown as it happens. */
const run = (file: string, args: string[]): number => spawnSync(file, args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;

/** A port nothing is listening on, the way scripts/check-contract.mjs picks one for the service. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) {
        server.close();
        reject(new CouldNotRun("no free port for the preview server"));
        return;
      }
      server.close(() => resolve(port));
    });
  });
}

/** Waits until the preview server answers, and says what it printed when it never does. */
async function waitForPreview(url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet; try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new CouldNotRun(`vite preview did not answer at ${url}. ${output().slice(-400)}`);
}

/** The journey itself. Locators wait for what they name, so each step passes only when the board shows it. */
async function journey(page: Page): Promise<void> {
  const title = "Write the browser smoke";
  const input = page.getByLabel("Task title");
  await input.fill(title);
  await input.press("Enter"); // The keyboard path, not the button: the form submits the way a keyboard user does.
  const item = page.getByRole("listitem").filter({ hasText: title });
  await item.getByText("To do").waitFor();
  await item.getByRole("button", { name: "In progress" }).click();
  await item.getByText("In progress").waitFor();
  await page.reload();
  await item.getByText("In progress").waitFor(); // After a reload the service still holds it: persistence, not memory.
  const refused = "a".repeat(201); // One character over the contract's longest title: the API must refuse it.
  await input.fill(refused);
  await input.press("Enter");
  const alert = page.getByRole("alert");
  await alert.waitFor();
  const reason = await alert.textContent();
  expect(reason !== null && reason.trim().length > 0, "the board showed no reason for the refused title");
  expect((await page.getByRole("listitem").filter({ hasText: refused }).count()) === 0, "the refused title became a task");
}

const taskApi = process.argv[2];
if (taskApi === undefined) {
  console.error("usage: node scripts/e2e.ts <task-api-url>");
  process.exit(2);
}

mkdirSync(join(ROOT, "test-results"), { recursive: true });
try {
  // Chromium first: a machine that cannot download it fails here, before anything else runs.
  if (run(process.execPath, [PLAYWRIGHT, "install", "chromium"]) !== 0) throw new CouldNotRun("Chromium did not install");
  if (run(process.execPath, [VITE, "build"]) !== 0) throw new CouldNotRun("the app did not build");
  const port = await freePort();
  const preview = spawn(process.execPath, [VITE, "preview", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, TASK_API: taskApi },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  preview.stdout.on("data", (chunk: Buffer) => {
    printed += chunk;
  });
  preview.stderr.on("data", (chunk: Buffer) => {
    printed += chunk;
  });
  try {
    await waitForPreview(`http://127.0.0.1:${port}/`, () => printed);
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${port}/`);
        await journey(page);
        await context.tracing.stop();
      } catch (err) {
        await context.tracing.stop({ path: TRACE });
        console.error(`e2e: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`e2e: trace at ${TRACE}`);
        process.exitCode = 1;
      }
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill();
  }
} catch (err) {
  console.error(`e2e: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
