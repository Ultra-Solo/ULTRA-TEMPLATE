// ADR-0041: the template has no version of its own — no tags, no releases, no changelog.
// These guards fail if self-versioning creeps back into the template machinery: a version in
// features.json, a reappearing release file, or a reference to a template release tag.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadManifest, ROOT, validateManifest } from "./init.mjs";

const tracked = () => execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

// Release machinery removed with ADR-0041. Tracked again means the template versions itself.
const REMOVED = [
  "CHANGELOG.md",
  ".github/workflows/template-release.yml",
  ".github/agents/release-cadence.agent.md",
  "template/release-cadence.md",
  "template/release-notes.mjs",
  "template/release-notes.test.mjs",
  "template/check-release.mjs",
  "template/check-publication.mjs",
  "template/cadence.test.mjs",
  "template/release-check.test.mjs",
];

test("features.json declares no version and provenance schema 2", () => {
  const manifest = loadManifest(ROOT);
  assert.equal(manifest.version, undefined, "features.json must not carry a template version");
  assert.equal(manifest.provenanceSchema, 2, "provenance must be commit-only (schema 2)");
  const problems = validateManifest({ ...manifest, version: "3.18.0" }, () => true);
  assert.ok(problems.some((p) => p.includes('"version"')), "a manifest with a version must be rejected");
});

test("the release files removed by ADR-0041 stay removed", () => {
  const files = new Set(tracked());
  for (const path of REMOVED) assert.equal(files.has(path), false, `${path} is tracked again`);
  for (const path of files) assert.equal(path.startsWith("template/notes/"), false, `${path} is a release note`);
});

test("no template machinery references a template release tag", () => {
  // init.mjs and template-update.mjs keep the tag URL only to read and rewrite legacy (schema 1)
  // projects' changelogs; tests carry it as fixtures. Everything else must stay commit-only.
  const SKIP = [/^docs\//, /\.test\.mjs$/, /^template\/init\.mjs$/, /^scripts\/template-update\.mjs$/];
  const MACHINERY = /^(template|scripts|\.github|data)\//;
  const offenders = tracked()
    .filter((p) => MACHINERY.test(p) && !SKIP.some((re) => re.test(p)))
    .filter((p) => /releases\/tag\/v\d/.test(readFileSync(`${ROOT}/${p}`, "utf8")));
  assert.deepEqual(offenders, []);
});
