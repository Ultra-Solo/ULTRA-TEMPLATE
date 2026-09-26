// The README's opening list is the template's promise to someone deciding whether to use it. Each claim
// is held to what enforces it. Template-only: init deletes this file along with the block it reads, so a
// generated project neither has these claims nor runs this test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../scripts/modules.mjs";
import { auditLedger, claims } from "../test/claims.mjs";

const LEDGER = {
  "One gate.": { rules: [9], paths: ["scripts/verify.mjs", ".github/workflows/verify.yml"] },
  "A pinned supply chain the build enforces.": {
    rules: [8, 14, 15, 16, 17, 19],
    paths: ["scripts/tools/tools.json", "scripts/tools.mjs", "scripts/check-pins.mjs", ".github/workflows/pins.yml", ".github/workflows/mcp-publish.yml"],
  },
  "Repository hygiene checks.": { rules: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13] },
  "Clean Architecture services whose layer rules are tests": {
    paths: [
      "services/api-go/internal/architecture_test.go",
      "services/api-go/internal/effects_test.go",
      "services/api-ts/scripts/check-boundaries.mjs",
      "services/mcp-server/scripts/check-boundaries.mjs",
      "services/api-go/internal/repo/repotest/repotest.go",
      "services/api-ts/test/task-repository-conformance.ts",
      "services/api-py/tests/task_repository_conformance.py",
      "services/api-py/scripts/check_boundaries.py",
      "scripts/check-contract.mjs",
      "scripts/contract/tasks-api.json",
      "scripts/contract/openapi.json",
    ],
  },
  "One statement of the rules.": { paths: ["scripts/rules/task-rules.json", "scripts/check-facts.mjs", "test/check-facts.test.mjs"] },
  "A feature-sliced web app and a publishable library": {
    paths: ["apps/web/scripts/check-boundaries.mjs", "packages/ts-library/scripts/check-install.mjs"],
  },
  "An MCP server for agents": { paths: ["services/mcp-server/test/mcp.test.ts"] },
  "Architecture as code.": { paths: ["architecture/rules.mjs", "architecture/test/model.test.mjs"] },
  "One set of instructions for agents.": { paths: ["scripts/check-docs.mjs"] },
  "Selectable features, tested.": {
    paths: [".github/workflows/template-test.yml", "template/init.test.mjs", "template/template-update.test.mjs"],
  },
  "The same checks everywhere.": {
    paths: [
      "biome.jsonc",
      "scripts/modules.mjs",
      "scripts/verify.mjs",
      "scripts/tools.mjs",
      ".github/actions/module/action.yml",
      "scripts/agent-env.mjs",
      ".claude/settings.json",
      "scripts/coverage-summary.mjs",
      ".github/workflows/verify.yml",
    ],
  },
};

/** The claims of the README's first template block: the list a newcomer reads before anything else. */
const readmeClaims = () => {
  const text = readFileSync(join(ROOT, "README.md"), "utf8");
  const begin = `<!-- ultra:${"begin"} template -->`;
  const start = text.indexOf(begin);
  return claims(text.slice(start, text.indexOf(`<!-- ultra:${"end"} template -->`, start)));
};

test("every claim in the README names what enforces it, and everything it names is there", () => {
  assert.ok(readmeClaims().length > 0, "the README has no template block to read");
  assert.deepEqual(auditLedger(readmeClaims(), LEDGER), []);
});
