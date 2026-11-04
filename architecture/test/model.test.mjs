import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LikeC4 } from "likec4";
import * as rules from "../rules.mjs";

const workspace = fileURLToPath(new URL("../model", import.meta.url));
// throwIfInvalid: a model with a syntax or reference error fails here, not later in a diagram.
const model = await (await LikeC4.fromWorkspace(workspace, { throwIfInvalid: true })).computedModel();

const ruleEntries = Object.entries(rules).filter(([, value]) => typeof value === "function");

test("the model satisfies every rule", () => {
  for (const [name, check] of ruleEntries) {
    assert.deepEqual(check(model), [], `${name} found violations in the real model`);
  }
});

// A rule proven only against a clean model passes just as well when it is broken (ADR-0043).
test("every rule ships a failing case and fires on it", () => {
  for (const [name, check] of ruleEntries) {
    const broken = rules.violating?.[name];
    assert.ok(broken, `rule "${name}" has no entry in rules.mjs \`violating\`; add a hand-built model that breaks it`);
    assert.ok(check(broken).length > 0, `rule "${name}" does not fire on its \`violating\` model`);
  }
});
