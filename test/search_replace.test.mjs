import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { search_replace } from "../scripts/search_replace.mjs";

const SR = fileURLToPath(import.meta.url).replace(/test[\\/]search_replace\.test\.mjs$/, join("scripts", "search_replace.mjs"));

describe("search_replace API", () => {
  it("rejects non-string text", () => {
    const r = search_replace(123, "a");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "text must be a string");
  });

  it("rejects empty search after normalization", () => {
    const r = search_replace("hello world", "");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "search text is empty after normalization");
  });

  it("rejects a file with no lines", () => {
    const r = search_replace("", "x");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "input text has no lines");
  });

  it("Pass 1 strict match succeeds byte-for-byte", () => {
    const result = search_replace(
      "line one\nline two\nline three\nline four\nline five\n",
      "line two\n",
      "line TWO"
    );
    assert.equal(result.ok, true);
    assert.equal(result.details.pass, "pass1");
    assert.equal(result.result, "line one\nline TWO\nline three\nline four\nline five\n");
  });

  it("Pass 1 strict match fails on a single different character", () => {
    const r = search_replace("line one\nline two\nline three\n", "line twoX");
    assert.equal(r.ok, false);
  });

  it("Pass 2 whitespace-tolerant match succeeds", () => {
    const result = search_replace("line one\n   line two   \nline three\n", "line two");
    assert.equal(result.ok, true);
    assert.equal(result.details.pass, "pass2");
  });

  it("Pass 3 truncation-artifact-skipping match succeeds", () => {
    const result = search_replace("line one\n[DEL]\n[DEL]\nline three\nline four\n", "line one\nline three\n");
    assert.equal(result.ok, true);
    assert.equal(result.details.pass, "pass3");
    assert.ok(!result.result.includes("[DEL]"));
  });

  it("Pass 3 requires at least two real lines to skip", () => {
    const r = search_replace("line one\n[DEL]\nline three\n", "line one\nline three\n");
    assert.equal(r.ok, true);
    assert.equal(r.details.pass, "pass3");
    assert.ok(!r.result.includes("[DEL]"));
    const r2 = search_replace("a\n[DEL]\n", "a\n");
    assert.equal(r2.ok, true);
  });

  it("Pass 4 unique substring match succeeds", () => {
    // A needle inside a longer line fails passes 1-3 (no whole-line equality)
    // and is long enough (> 5 chars) for the substring pass.
    const result = search_replace("const alpha = compute(x);\n", "compute(x)", "read(y)");
    assert.equal(result.ok, true);
    assert.equal(result.details.pass, "pass4");
    assert.equal(result.result, "read(y)");
  });

  it("Pass 4 rejects a non-unique substring", () => {
    const r = search_replace("foo compute(x)\nbar compute(x)\n", "compute(x)", "read(y)");
    assert.equal(r.ok, false);
  });

  it("Pass 5 single-line anchor: shadowed by Pass 2's trim", () => {
    // Pass 5 strips only trailing whitespace of the search, but Pass 2 trims
    // both sides of every line, so every single-line case Pass 5 could match,
    // Pass 2 matches first. Port fidelity keeps Pass 5 as defense-in-depth.
    const result = search_replace("alpha\nbeta   \ngamma\n", "beta", "BETA");
    assert.equal(result.ok, true);
    assert.equal(result.details.pass, "pass2");
    assert.equal(result.result, "alpha\nBETA\ngamma\n");
  });

  it("deletion (no replace) removes the match", () => {
    const result = search_replace("line one\nline two\nline three\n", "line two\n");
    assert.equal(result.ok, true);
    assert.equal(result.result, "line one\nline three\n");
  });

  it("all-or-nothing: no partial edits", () => {
    const result = search_replace("line one\nline two\nline three\nline four\n", "line two\nline three", "line TWO\nline THREE");
    assert.equal(result.ok, true);
    assert.equal(result.result, "line one\nline TWO\nline THREE\nline four\n");
  });

  it("line endings preserved (Windows \\r\\n)", () => {
    const input = "line one\r\nline two\r\nline three\r\n";
    const result = search_replace(input, "line two", "line TWO");
    assert.equal(result.ok, true);
    assert.ok(result.result.includes("\r\n"));
    assert.equal((result.result.match(/\r\n/g) || []).length, 3);
    assert.equal(result.result, "line one\r\nline TWO\r\nline three\r\n");
  });

  it("replacement adopts the host file's native line ending", () => {
    const input = "line one\r\nline two\r\nline three\r\n";
    const result = search_replace(input, "line two", "NEW LINE");
    assert.equal(result.ok, true);
    assert.ok(result.result.includes("\r\n"));
    assert.ok(result.result.includes("NEW LINE\r\n"));
  });

  it("line endings preserved (Unix \\n)", () => {
    const input = "line one\nline two\nline three\n";
    const result = search_replace(input, "line two\n");
    assert.equal(result.ok, true);
    assert.ok(!result.result.includes("\r"));
  });

  it("catastrophic edit blocking: over 30% AND > 25 lines removed", () => {
    const input = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
    // The guard is strictly greater-than: removing exactly 30 lines from a
    // 100-line file sits on max(25, floor(100 * 0.3)) = 30 and is allowed.
    const boundary = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    assert.equal(search_replace(input, boundary).ok, true);
    const blocked = Array.from({ length: 31 }, (_, i) => `line ${i}\n`).join("");
    const result = search_replace(input, blocked);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("catastrophic"));
  });

  it("catastrophic edit blocking: under 30% allowed", () => {
    const input = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
    const result = search_replace(input, "line 50\n");
    assert.equal(result.ok, true);
  });

  it("catastrophic edit blocking: <= 25 lines allowed even at high %", () => {
    const input = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    const needle = Array.from({ length: 25 }, (_, i) => `line ${i}\n`).join("");
    const result = search_replace(input, needle);
    assert.equal(result.ok, true);
  });

  it("catastrophic edit blocking: custom limit honored", () => {
    const input = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    // The limit is a hard cap on removed lines, not a target: removing one
    // line is allowed under a cap of 1 and blocked under a cap of 0.
    assert.equal(search_replace(input, "line 0\n", "X\n", 1).ok, true);
    const result = search_replace(input, "line 0\n", undefined, 0);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("catastrophic"));
  });
});

describe("search_replace CLI", () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(join(tmpdir(), "sr-cli-"));
  });
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A bounded spawn anywhere: whatever breaks inside the child must fail the
  // test within its own window, never hang the runner.
  const runCli = (file, searchText, opts = {}) => {
    const sfile = join(tmpDir, "sr-search.txt");
    fs.writeFileSync(sfile, searchText);
    const cmd = [SR, "--file", file, "--search-file", sfile];
    if (opts.replace != null) cmd.push("--replace", opts.replace);
    if (opts.dryRun) cmd.push("--dry-run");
    return spawnSync(process.execPath, cmd, {
      encoding: "utf8",
      cwd: tmpDir,
      timeout: 20_000,
      windowsHide: true,
    });
  };

  it("--dry-run prints result and writes nothing", () => {
    const scratch = join(tmpDir, "scratch.txt");
    fs.writeFileSync(scratch, "line one\nline two\nline three\n");
    const out = runCli(scratch, "line two\n", { replace: "line two REPLACED\n", dryRun: true });
    assert.equal(out.error, undefined, String(out.error));
    assert.equal(out.stdout, "line one\nline two REPLACED\nline three\n");
    assert.equal(out.status, 0);
    assert.equal(fs.readFileSync(scratch, "utf8"), "line one\nline two\nline three\n");
  });

  it("exits 1 when replacement fails", () => {
    const scratch = join(tmpDir, "scratch.txt");
    fs.writeFileSync(scratch, "line one\nline two\nline three\n");
    const out = runCli(scratch, "NOTPRESENT\n");
    assert.notEqual(out.status, 0);
    assert.ok(out.stderr.includes("replacement failed"));
  });

  it("exits 2 on misuse", () => {
    const scratch = join(tmpDir, "scratch.txt");
    fs.writeFileSync(scratch, "line one\n");
    // No --search and no --search-file: the missing search source is misuse.
    const out = spawnSync(process.execPath, [SR, "--file", scratch], {
      encoding: "utf8",
      cwd: tmpDir,
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(out.status, 2);
    assert.ok(out.stderr.includes("usage:"));
  });

  it("writes the file for a real replacement", () => {
    const scratch = join(tmpDir, "scratch2.txt");
    fs.writeFileSync(scratch, "line one\nline two\nline three\n");
    const out = runCli(scratch, "line two\n", { replace: "line TWO\n" });
    assert.equal(out.error, undefined, String(out.error));
    assert.equal(out.status, 0);
    assert.equal(fs.readFileSync(scratch, "utf8"), "line one\nline TWO\nline three\n");
  });
});
