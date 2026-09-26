// The pin report must be seen to report: a pin behind its latest release, and a lookup that failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { report, table } from "../scripts/check-pins.mjs";

test("a pin behind its latest release is reported, one at it is current, and a failed lookup says so", async () => {
  const tools = {
    ahead: { version: "1.0.0", for: "ci", releases: { github: "octo/ahead" }, run: ["ahead"] },
    level: { version: "2.0.0", for: "ci", releases: { github: "octo/level" }, run: ["level"] },
    tagged: { version: "1.8.0", for: "ci", releases: { githubTags: "octo/tagged" }, run: ["tagged"] },
    audit: { version: "3.0.0", for: "ci", releases: { pypi: "audit" }, run: ["audit"] },
  };
  const answers = {
    "https://api.github.com/repos/octo/ahead/releases/latest": { tag_name: "v1.1.0" },
    "https://api.github.com/repos/octo/level/releases/latest": { tag_name: "v2.0.0" },
    "https://api.github.com/repos/octo/tagged/tags?per_page=100": [{ name: "v1.10.0" }, { name: "v1.9.0" }, { name: "v1.11.0-rc.1" }],
  };
  const fetch = async (url) => (url in answers ? new Response(JSON.stringify(answers[url])) : new Response("{}", { status: 503 }));
  const byName = Object.fromEntries((await report({ tools, fetch })).map((row) => [row.name, row]));
  assert.equal(byName.ahead.behind, true);
  assert.equal(byName.level.behind, false);
  // Tags are compared as versions, not as text, and a release candidate is not a release.
  assert.equal(byName.tagged.newest, "1.10.0");
  assert.match(byName.audit.error, /PyPI audit answered 503/);
  const rendered = table(Object.values(byName));
  assert.match(rendered, /\| ahead \| 1\.0\.0 \| 1\.1\.0 \| \*\*newer release\*\* \|/);
  assert.match(rendered, /\| audit \| 3\.0\.0 \| \? \| could not check: PyPI audit answered 503 \|/);
});

test("a pinned checksum is compared with the one its release publishes, and a mismatch names the published one", async () => {
  const { checksumReport, checksumTable } = await import("../scripts/check-pins.mjs");
  const [good, bad] = ["a".repeat(64), "b".repeat(64)];
  const tools = {
    demo: {
      version: "1.2.3",
      for: "ci",
      releases: { github: "octo/demo" },
      checksums: { file: "https://example.test/v{version}/sums.txt" },
      platforms: {
        "linux-x64": { url: "https://example.test/v{version}/demo-x64.tgz", sha256: good, files: ["demo"] },
        "linux-arm64": { url: "https://example.test/v{version}/demo-arm64.tgz", sha256: "0".repeat(64), files: ["demo"] },
      },
    },
    gone: { version: "1.0.0", for: "ci", releases: { github: "octo/gone" }, checksums: { sidecar: ".sha256" }, platforms: { "linux-x64": { url: "https://example.test/gone.tgz", sha256: good, files: ["gone"] } } },
    byVersion: { version: "1.0.0", for: "ci", releases: { pypi: "x" }, run: ["x"] },
  };
  const answers = { "https://example.test/v1.2.3/sums.txt": `${good}  demo-x64.tgz\n${bad}  demo-arm64.tgz\n` };
  const fetch = async (url) => (url in answers ? new Response(answers[url]) : new Response("", { status: 404 }));
  const rows = await checksumReport({ tools, fetch });
  assert.deepEqual(
    rows.map((r) => [r.name, r.platform, r.state]),
    [
      ["demo", "linux-x64", "match"],
      ["demo", "linux-arm64", "differs"],
      ["gone", "linux-x64", "error"],
    ],
    "a tool run by version has no asset to compare",
  );
  assert.equal(rows[1].published, bad);
  const rendered = checksumTable(rows);
  assert.match(rendered, new RegExp(`\\| demo \\| linux-arm64 \\| \\*\\*differs\\*\\*: the release publishes \`${bad}\` \\|`));
  assert.match(rendered, /\| gone \| linux-x64 \| could not check: https:\/\/example\.test\/gone\.tgz\.sha256 answered 404 \|/);
});
