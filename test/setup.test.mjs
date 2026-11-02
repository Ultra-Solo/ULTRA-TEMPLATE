import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

/** A tree with its own copy of setup, so it runs against the fixture and not this checkout. */
const project = ({ committed }) => {
  const root = mkdtempSync(join(tmpdir(), "setup-"));
  mkdirSync(join(root, "scripts"));
  for (const file of ["setup.mjs", "modules.mjs"]) copyFileSync(join(SCRIPTS, file), join(root, "scripts", file));
  writeFileSync(join(root, "README.md"), "fixture\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet", "-b", "main");
  git("add", "-A");
  if (committed) git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--quiet", "-m", "fixture");
  return root;
};

const setup = (root) => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "setup.mjs")], { cwd: root, encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
};

test("setup tells a repository with no commit to commit before verify", () => {
  const { status, out } = setup(project({ committed: false }));
  assert.equal(status, 0, out);
  assert.match(out, /git add -A && git commit/);
  assert.ok(out.indexOf("git commit") < out.indexOf("verify.mjs"), out);
});

test("setup points a committed repository straight at verify", () => {
  const { status, out } = setup(project({ committed: true }));
  assert.equal(status, 0, out);
  assert.match(out, /next, node scripts\/verify\.mjs/);
  assert.doesNotMatch(out, /git commit/);
});
