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

// A model with no product in it is legitimate: `--features architecture` generates one, and the
// generator's own test insists it passes its checks. Nothing is narratable there, so nothing may be
// reported — a rule whose premise is absent must stay silent rather than blame the empty view.
test("a model with nothing to narrate satisfies every rule", () => {
  const chassisOnly = {
    elements: () => [],
    relationships: () => [],
    views: () => [{ id: "taskMove", isDynamicView: () => true, edges: () => [], includesRelation: () => false }],
  };
  for (const [name, check] of ruleEntries) {
    assert.deepEqual(check(chassisOnly), [], `${name} reported a violation on a model that has no product to narrate`);
  }
});

// `viewsSaySomething` has two arms — a dynamic view with no steps, and a step with no label — and the
// check below proves only that the rule fires, i.e. that one arm survived. Each arm is pinned here, so
// deleting either one fails instead of hiding behind the other's evidence.
test("viewsSaySomething reports an empty view and an unlabelled step", () => {
  const built = (id, kind) => ({ id, kind });
  const flow = { source: built("product.web", "webapp"), target: built("product.api", "service") };
  const emptyView = (id) => ({ id, isDynamicView: () => true, edges: () => [], includesRelation: () => false });
  const stepView = (id, label) => ({
    id,
    isDynamicView: () => true,
    edges: () => [{ isStep: () => true, source: flow.source, target: flow.target, label }],
    includesRelation: () => false,
  });
  const withFlows = (views) => ({ elements: () => [], relationships: () => [flow], views: () => views });

  assert.deepEqual(rules.viewsSaySomething(withFlows([emptyView("taskMove")])), [
    "taskMove is a dynamic view with no steps: it narrates nothing",
  ]);
  assert.deepEqual(rules.viewsSaySomething(withFlows([stepView("taskMove", "  ")])), [
    "taskMove: step product.web -> product.api has no label",
  ]);
  // The same two views are blameless where the premise is absent: nothing is narratable there.
  assert.deepEqual(
    rules.viewsSaySomething({
      elements: () => [],
      relationships: () => [],
      views: () => [emptyView("taskMove"), stepView("taskStatus", "")],
    }),
    [],
  );
});

// A rule proven only against a clean model passes just as well when it is broken (ADR-0043).
test("every rule ships a failing case and fires on it", () => {
  for (const [name, check] of ruleEntries) {
    const broken = rules.violating?.[name];
    assert.ok(broken, `rule "${name}" has no entry in rules.mjs \`violating\`; add a hand-built model that breaks it`);
    assert.ok(check(broken).length > 0, `rule "${name}" does not fire on its \`violating\` model`);
  }
});
