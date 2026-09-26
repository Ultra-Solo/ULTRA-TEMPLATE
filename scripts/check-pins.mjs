/**
 * Reports which hand-pinned tools have a newer release. Dependabot moves actions, images and module
 * dependencies; these it cannot see, so every one is declared in scripts/tools/tools.json, and this lists
 * each against the latest release where its manifest entry says it is published.
 *
 * Report-only, like the scans in security.yml: a newer release is information, not a failure, since a
 * pin moves only after someone reads the release (`node scripts/tools.mjs bump NAME` then takes its
 * checksum from it; docs/toolchain-updates.md). The run fails only when a lookup could not be made.
 *
 * With --checksums it instead compares every pinned SHA-256, for every platform, with the one the
 * release publishes, and fails on a difference. CI downloads only the linux-x64 assets, so this is what
 * proves the others before someone on another machine installs them. A mismatch prints the published
 * value, which is how a new platform's pin is taken from the release rather than from a download.
 *
 *   node scripts/check-pins.mjs              # needs network; GH_TOKEN raises GitHub's rate limit
 *   node scripts/check-pins.mjs --checksums
 *
 * Prints a Markdown table. Exit 0 every pin was looked up (and every checksum matches) · 1 a checksum
 * differs · 2 a lookup failed.
 */
import { pathToFileURL } from "node:url";
import { compareVersions, latest, loadTools, publishedChecksum } from "./tools.mjs";

/** One row per pinned tool: its version, the latest, and whether it is behind. Lookups that fail are rows too. */
export async function report({ tools = loadTools(), fetch = globalThis.fetch, token } = {}) {
  const rows = [];
  for (const [name, tool] of Object.entries(tools)) {
    try {
      const newest = await latest(name, { tools, fetch, token });
      rows.push({ name, pinned: tool.version, newest, behind: compareVersions(newest, tool.version) > 0 });
    } catch (err) {
      rows.push({ name, pinned: tool.version, error: err.message });
    }
  }
  return rows;
}

export function table(rows) {
  const lines = ["| Tool | Pinned | Latest | |", "|---|---|---|---|"];
  for (const row of rows) {
    const state = row.error ? `could not check: ${row.error}` : row.behind ? "**newer release**" : "current";
    lines.push(`| ${row.name} | ${row.pinned} | ${row.newest ?? "?"} | ${state} |`);
  }
  return lines.join("\n");
}

/** One row per downloaded asset: whether its pinned SHA-256 is the one its release publishes. */
export async function checksumReport({ tools = loadTools(), fetch = globalThis.fetch, token } = {}) {
  const rows = [];
  for (const [name, tool] of Object.entries(tools)) {
    for (const [platform, asset] of Object.entries(tool.platforms ?? {})) {
      try {
        const published = await publishedChecksum(tool, asset, { fetch, token });
        rows.push({ name, platform, pinned: asset.sha256, published, state: published === asset.sha256 ? "match" : "differs" });
      } catch (err) {
        rows.push({ name, platform, pinned: asset.sha256, state: "error", error: err.message });
      }
    }
  }
  return rows;
}

export function checksumTable(rows) {
  const lines = ["| Tool | Platform | |", "|---|---|---|"];
  for (const row of rows) {
    const state = row.state === "match" ? "matches the release" : row.state === "differs" ? `**differs**: the release publishes \`${row.published}\`` : `could not check: ${row.error}`;
    lines.push(`| ${row.name} | ${row.platform} | ${state} |`);
  }
  return lines.join("\n");
}

async function main(argv) {
  if (argv.includes("--checksums")) {
    const rows = await checksumReport({ token: process.env.GH_TOKEN });
    console.log(`### Pinned checksums against their releases\n\n${checksumTable(rows)}`);
    return rows.some((row) => row.state === "error") ? 2 : rows.some((row) => row.state === "differs") ? 1 : 0;
  }
  const rows = await report({ token: process.env.GH_TOKEN });
  console.log(`### Hand-pinned tools\n\n${table(rows)}\n\nMove a pin with \`node scripts/tools.mjs bump NAME\`, which takes the checksum from the release: docs/toolchain-updates.md.`);
  return rows.some((row) => row.error) ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
