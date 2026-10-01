/** Exercise default publication resolution against a retained, known upstream release in CI. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, main } from "./init.mjs";
import { readProvenance } from "../scripts/template-source.mjs";

const work = mkdtempSync(join(tmpdir(), "published-bootstrap-"));
try {
  // A copy's manifest is sufficient; its own Git history must not become the upstream source.
  const bootstrap = join(work, "copy");
  mkdirSync(join(bootstrap, "template"), { recursive: true });
  const manifest = loadManifest();
  manifest.version = "2.1.0";
  writeFileSync(join(bootstrap, "template/features.json"), JSON.stringify(manifest));
  const out = join(work, "project");
  await main(["--preset", "minimal", "--name", "demo-app", "--owner", "octo-org", "--out", out], bootstrap);
  const record = readProvenance(out);
  assert.equal(record.source.version, "v2.1.0");
  assert.equal(record.source.tag, "v2.1.0");
  // Captured from the published v2.1.0 merge, not the CI checkout or this synthetic copy.
  assert.equal(record.source.commit, "d948667ffcc593523eb985d35bd3aa515fb24e51");
  console.log("check-publication: published upstream commit resolved and recorded.");
} finally { rmSync(work, { recursive: true, force: true }); }
