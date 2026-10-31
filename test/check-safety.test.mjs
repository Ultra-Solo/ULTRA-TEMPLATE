import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { checkSafety } from "../scripts/check-safety.mjs";

const BASE = Array.from({ length: 70 }, (_, i) => `// baseline line ${i + 1}`).join("\n");

let lastRoot = null;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "safety-"));
  lastRoot = root;
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "src/main.js"), BASE);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "--allow-empty-message", "--message", ""], { cwd: root, stdio: "ignore" });
  return root;
}

after(() => {
  if (lastRoot) rmSync(lastRoot, { recursive: true, force: true });
});

test("rejects a deletion over 30% of the file and > 25 lines (no compensation)", () => {
  const root = fixture();
  try {
    const p = join(root, "src/main.js");
    writeFileSync(p, "// only line one\n// only line two\n// only line three\n"); // 3 kept, ~31 deleted
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    const r = checkSafety(root).report.hardRejections;
    assert.equal(r.length, 1);
    assert.equal(r[0].path, "src/main.js");
    assert.ok(r[0].pct >= 30, `expected pct >= 30, got ${r[0].pct}`);
    assert.ok(r[0].deleted > 25, `expected deletions > 25, got ${r[0].deleted}`);
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});

test("rejects 50% removal of any text file", () => {
  const root = fixture();
  try {
    const p = join(root, "src/main.js");
    writeFileSync(p, "");
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    const r = checkSafety(root).report.hardRejections;
    assert.equal(r.length, 1);
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});

test("accepts a small edit (below warning band)", () => {
  const root = fixture();
  try {
    const p = join(root, "src/main.js");
    // Replace one line so the diff is small; the old pattern matched nothing in BASE,
    // which made the file identical and the diff empty — the test proved nothing.
    writeFileSync(p, BASE.replace("// baseline line 5\n", "// edited baseline line 5\n"));
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    const report = checkSafety(root);
    assert.equal(report.ok, true);
    assert.equal(report.report.hardRejections.length, 0);
    assert.equal(report.report.warnings.length, 0);
    assert.equal(report.report.changes.length, 1);
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});

test("allows a true rewrite with compensating additions (20%+ of new file)", () => {
  const root = fixture();
  try {
    const p = join(root, "src/main.js");
    const newContent = Array.from({ length: 30 }, (_, i) => `// new line ${i + 1}`).join("\n");
    writeFileSync(p, newContent + "\n");
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    const r = checkSafety(root).report.hardRejections;
    assert.equal(r.length, 0, "compensating rewrite should not hard-reject");
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});

test("new files are not rejected", () => {
  const root = fixture();
  try {
    const p = join(root, "src/new.js");
    writeFileSync(p, "// new\n".repeat(100));
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    const report = checkSafety(root);
    assert.equal(report.ok, true);
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});

test("deleted files are ignored by the gate", () => {
  const root = fixture();
  try {
    const p = join(root, "src/main.js");
    rmSync(p);
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    const report = checkSafety(root);
    assert.equal(report.ok, true);
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});

test("the CLI rejects a mass deletion", () => {
  const root = fixture();
  try {
    const p = join(root, "src/main.js");
    writeFileSync(p, "// one line\n");
    execFileSync("git", ["add", "-A", "--force"], { cwd: root, stdio: "ignore" });
    try {
      execFileSync("node", ["../scripts/check-safety.mjs"], { cwd: root, stdio: "ignore" });
      assert.fail("expected non-zero exit");
    } catch (e) {
      assert.ok(e.status !== 0, "expected exit code != 0, got " + e.status);
    }
  } finally {
    if (lastRoot) { rmSync(lastRoot, { recursive: true, force: true }); lastRoot = null; }
  }
});
