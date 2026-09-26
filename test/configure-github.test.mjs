import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTIONS_APP_ID, deploymentEnvironments, isRepo, plan, REQUIRED_CHECK, RULESET, TAG_RULESET } from "../scripts/configure-github.mjs";

test("the required check is a job that verify.yml actually defines", () => {
  // A ruleset naming a check no workflow reports would block every pull request forever.
  const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  assert.match(workflow, new RegExp(`^ {2}${REQUIRED_CHECK}:\\s*$`, "m"));
});

test("the ruleset requires pull requests and the verify check from GitHub Actions, with no bypass", () => {
  const rule = (type) => RULESET.rules.find((r) => r.type === type);
  assert.deepEqual(rule("required_status_checks").parameters.required_status_checks, [{ context: "verify", integration_id: ACTIONS_APP_ID }]);
  assert.equal(rule("required_status_checks").parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(rule("pull_request").parameters.allowed_merge_methods, ["squash"]);
  // GitHub added this parameter defaulted on; unset, it would block a sole maintainer's own merges.
  assert.equal(rule("pull_request").parameters.require_extra_approval_for_unattributed_changes, false);
  assert.ok(rule("non_fast_forward") && rule("deletion"));
  assert.deepEqual(RULESET.bypass_actors, []);
  assert.deepEqual(RULESET.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
});

test("release settings are applied only when the release workflow exists", () => {
  const names = (release) => plan("octo/app", { release }).map((s) => s.name).join("\n");
  assert.doesNotMatch(names(false), /RELEASE_ENABLED|open pull requests/);
  assert.match(names(true), /RELEASE_ENABLED=true/);
  assert.match(names(true), /open pull requests/);
});

test("only plan- or visibility-dependent settings are optional", () => {
  const optional = plan("octo/app", { release: true }).filter((s) => s.optional).map((s) => s.name);
  assert.deepEqual(optional, ["private vulnerability reporting", "secret scanning and push protection"]);
});

test("merging is squash-only with the pull request title as the commit title", () => {
  const { body } = plan("octo/app", { release: false })[0];
  assert.deepEqual(
    [body.allow_squash_merge, body.allow_merge_commit, body.allow_rebase_merge, body.squash_merge_commit_title, body.delete_branch_on_merge],
    [true, false, false, "PR_TITLE", true],
  );
});

test("the repository argument is validated before any request", () => {
  assert.equal(isRepo("octo-org/demo.app_1"), true);
  for (const bad of ["octo", "octo/app/extra", "../x", "octo/app?x=1", "", undefined]) assert.equal(isRepo(bad), false, String(bad));
});

test("release tags can be created but never moved or deleted, by anyone", () => {
  assert.equal(TAG_RULESET.target, "tag");
  assert.deepEqual(TAG_RULESET.conditions.ref_name.include, ["refs/tags/v*"]);
  assert.deepEqual(TAG_RULESET.rules.map((r) => r.type).sort(), ["deletion", "non_fast_forward", "update"]);
  assert.equal(TAG_RULESET.rules.some((r) => r.type === "creation"), false, "releasing creates them");
  assert.deepEqual(TAG_RULESET.bypass_actors, []);
  assert.ok(plan("octo/app", { release: false }).some((s) => s.upsertRuleset === TAG_RULESET));
});

test("each deployment environment a workflow names is limited to the default branch", () => {
  const workflows = {
    "release.yml": "jobs:\n  publish:\n    environment: npm\n    runs-on: ubuntu-latest\n",
    "mcp.yml": "jobs:\n  publish:\n    environment: 'mcp-registry'\n",
    "pages.yml": "jobs:\n  deploy:\n    environment:\n      name: github-pages\n",
    "other.yml": "jobs:\n  a:\n    # environment: commented\n    runs-on: x\n",
  };
  assert.deepEqual(deploymentEnvironments(workflows), ["mcp-registry", "npm"], "Pages manages its own environment");
  const steps = plan("octo/app", { release: true, environments: ["npm"], defaultBranch: "trunk" }).filter((s) => s.upsertEnvironment);
  assert.deepEqual(steps.map((s) => s.upsertEnvironment), [{ name: "npm", branch: "trunk" }]);
  assert.equal(steps[0].optional, undefined, "a publishing environment anyone could deploy from is not optional");
  assert.equal(plan("octo/app", { release: false }).some((s) => s.upsertEnvironment), false);
});

test("the ruleset needs Actions to open pull requests only for release-please, and approves none", () => {
  const step = plan("octo/app", { release: true }).find((s) => s.path?.endsWith("/actions/permissions/workflow"));
  assert.deepEqual(step.body, { default_workflow_permissions: "read", can_approve_pull_request_reviews: true });
  assert.equal(RULESET.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count, 0);
});
