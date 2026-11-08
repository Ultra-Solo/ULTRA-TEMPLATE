/**
 * Hold a generated project's guides to the files it actually ships (ADR-0051).
 *
 * A sibling of `test-source.mjs`: the generator's test calls this, and nothing else here is a test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./init.mjs";

// A guide that names a module this project does not have sends its reader — or an agent following it
// step by step — to a directory that is not there. The architecture model's comment prose is a guide
// too: LikeC4 validates a step's endpoints but never its words, so a comment naming a file the project
// does not have survives every architecture rule and `verify` with them (ADR-0051).
// A path is looked for only where it cannot be mistaken for prose: `architecture` is a word,
// `apps/web` is not, and the last segment counts only under services/ and .claude/skills/. ADRs are
// not guides: a decision record names what it decided.
export function assertGuidesNameWhatShips(out, selected, label, file) {
  const manifest = loadManifest();
  const text = readFileSync(join(out, file), "utf8");
  for (const path of absentPaths(manifest, selected)) {
    if (/[/.]/.test(path)) assert.ok(!text.includes(path), `${label}: ${file} names ${path}, which this project does not have`);
    if (!/^(services|\.claude\/skills)\//.test(path)) continue;
    assert.ok(!text.includes(path.split("/").at(-1)), `${label}: ${file} names ${path.split("/").at(-1)}, which this project does not have`);
  }
}

// The full sweep over every guide a project ships, for the feature-alone matrix where no loop
// skeleton exists in the caller.
export function assertEveryGuideNamesWhatShips(out, selected, label) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: out, encoding: "utf8" }).split("\0").filter(Boolean);
  const guides = [
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
    "docs/README.md",
    "architecture/README.md",
    ...tracked.filter((file) => file.startsWith(".claude/skills/") || file.endsWith(".c4")),
  ];
  for (const file of guides.filter((f) => existsSync(join(out, f)))) {
    assertGuidesNameWhatShips(out, selected, label, file);
  }
}

// A path several features own goes only when none of its owners is selected, so an unselected
// feature's path may still be here because another one keeps it.
export function absentPaths(manifest, selected) {
  return [...new Set(Object.values(manifest.features).flatMap((feature) => feature.paths))].filter(
    (path) => !Object.entries(manifest.features).some(([id, feature]) => selected.includes(id) && feature.paths.includes(path)),
  );
}