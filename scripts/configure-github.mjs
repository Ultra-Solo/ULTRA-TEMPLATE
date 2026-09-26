/**
 * Applies the repository settings GitHub does not copy from a template, so a new repository is
 * protected the way its workflows assume. Safe to run again: every setting is replaced, not added.
 *
 *   node scripts/configure-github.mjs --dry-run            # print every request, change nothing
 *   node scripts/configure-github.mjs                      # the repository `gh` resolves from origin
 *   node scripts/configure-github.mjs --repo owner/name
 *
 * Needs the GitHub CLI, signed in as an administrator of the repository.
 *
 * What it sets, and why:
 *   - Squash merging only, with the pull request title as the commit title, and merged branches
 *     deleted. pr-title.yml checks that title; on main it becomes the history release-please reads.
 *   - A ruleset on the default branch: changes arrive by pull request, the `verify` check from GitHub
 *     Actions must pass on an up-to-date branch (ADR-0002), and nobody force-pushes or deletes it. No
 *     bypass, administrators included. No approving review is required, so a sole maintainer can
 *     merge; raise it once there is a second. The same goes for GitHub's newer "extra approval for
 *     unattributed changes", which it turns on by default: a sole maintainer cannot approve their own
 *     pull request, so a commit GitHub does not attribute to them (an agent co-author, an unlinked
 *     email) would block their merge for good. It is set, explicitly, to off.
 *   - Dependabot alerts and security updates, and the private vulnerability reporting SECURITY.md links to.
 *   - Secret scanning and push protection. Free on public repositories; GitHub refuses them on a private
 *     repository without Advanced Security, and that is reported as unavailable rather than as a failure.
 *   - A ruleset on release tags (`v*`): anyone who may push can create one, and nobody, administrators
 *     included, moves or deletes it, so a version always names the code that was released.
 *   - Only when release.yml exists and init has run (template/ is gone): GitHub Actions may open pull
 *     requests, and RELEASE_ENABLED=true turns the release workflow on. Opening pull requests is the
 *     whole of what release-please needs; GitHub names the setting `can_approve_pull_request_reviews`,
 *     but with no approving review required by the ruleset there is nothing for Actions to approve.
 *     Each deployment environment a workflow names (npm, mcp-registry) then admits the default branch
 *     alone, the branch whose push runs the publishing jobs.
 *
 * Exit 0 applied · 1 a required setting failed · 2 invalid arguments or no usable `gh`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The GitHub Actions app. Naming it means only a status reported by Actions satisfies the rule. */
export const ACTIONS_APP_ID = 15368;

export const REQUIRED_CHECK = "verify";

export const RULESET = {
  name: "default-branch",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        // Declared rather than left to GitHub's default, which changed underneath this script once.
        require_extra_approval_for_unattributed_changes: false,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: REQUIRED_CHECK, integration_id: ACTIONS_APP_ID }],
      },
    },
  ],
};

/**
 * Release tags, once made, stay where they were made: nobody deletes or moves a `v*` tag, so a version
 * always names the code that was released and the notes written about it. Creating one stays open, since
 * releasing is how a tag is made.
 */
export const TAG_RULESET = {
  name: "release-tags",
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  bypass_actors: [],
  rules: [{ type: "deletion" }, { type: "update" }, { type: "non_fast_forward" }],
};

/**
 * The deployment environments the workflows name as a plain `environment: NAME`, sorted. GitHub Pages
 * writes its own (`environment: { name: github-pages }`) and limits it to the Pages branch itself.
 */
export function deploymentEnvironments(workflows) {
  const names = new Set();
  for (const text of Object.values(workflows)) {
    for (const line of text.split(/\r?\n/)) {
      const name = /^\s+environment:\s*["']?([\w.-]+)["']?\s*(?:#.*)?$/.exec(line)?.[1];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

export const isRepo = (value) => typeof value === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value);

/** Every change, in order. `optional` marks settings GitHub may refuse because of the plan or visibility. */
export function plan(repo, { release, environments = [], defaultBranch = "main" }) {
  const r = `repos/${repo}`;
  const steps = [
    {
      name: "squash merging only, branches deleted after merge",
      method: "PATCH",
      path: r,
      body: {
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        squash_merge_commit_title: "PR_TITLE",
        squash_merge_commit_message: "PR_BODY",
        delete_branch_on_merge: true,
        allow_update_branch: true,
      },
    },
    { name: `ruleset "${RULESET.name}": pull requests and the ${REQUIRED_CHECK} check`, upsertRuleset: RULESET },
    { name: `ruleset "${TAG_RULESET.name}": release tags are never moved or deleted`, upsertRuleset: TAG_RULESET },
    { name: "Dependabot alerts", method: "PUT", path: `${r}/vulnerability-alerts` },
    { name: "Dependabot security updates", method: "PUT", path: `${r}/automated-security-fixes` },
    { name: "private vulnerability reporting", method: "PUT", path: `${r}/private-vulnerability-reporting`, optional: true },
    {
      name: "secret scanning and push protection",
      method: "PATCH",
      path: r,
      body: { security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } },
      optional: true,
    },
  ];
  if (release) {
    steps.push(
      {
        name: "GitHub Actions may open pull requests (release-please)",
        method: "PUT",
        path: `${r}/actions/permissions/workflow`,
        body: { default_workflow_permissions: "read", can_approve_pull_request_reviews: true },
      },
      { name: "repository variable RELEASE_ENABLED=true", upsertVariable: { name: "RELEASE_ENABLED", value: "true" } },
    );
  }
  // A publishing job runs on the push to the default branch, so its environment admits that branch alone:
  // a workflow run from any other branch cannot reach the environment's trust (npm's trusted publisher,
  // the registry's OIDC login) even if someone edits the workflow there.
  for (const name of environments) {
    steps.push({ name: `environment ${name}: deployments from ${defaultBranch} only`, upsertEnvironment: { name, branch: defaultBranch } });
  }
  return steps;
}

function gh(method, path, body) {
  const args = ["api", "--method", method, path, "-H", "Accept: application/vnd.github+json"];
  if (body !== undefined) args.push("--input", "-");
  const out = execFileSync("gh", args, {
    input: body === undefined ? "" : JSON.stringify(body),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim() === "" ? null : JSON.parse(out);
}

function apply(repo, step) {
  const r = `repos/${repo}`;
  if (step.upsertRuleset) {
    const existing = gh("GET", `${r}/rulesets`).find((ruleset) => ruleset.name === step.upsertRuleset.name);
    if (existing) gh("PUT", `${r}/rulesets/${existing.id}`, step.upsertRuleset);
    else gh("POST", `${r}/rulesets`, step.upsertRuleset);
  } else if (step.upsertEnvironment) {
    const { name, branch } = step.upsertEnvironment;
    gh("PUT", `${r}/environments/${name}`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    const policies = gh("GET", `${r}/environments/${name}/deployment-branch-policies`).branch_policies;
    for (const policy of policies.filter((p) => p.name !== branch || p.type !== "branch")) gh("DELETE", `${r}/environments/${name}/deployment-branch-policies/${policy.id}`);
    if (!policies.some((p) => p.name === branch && p.type === "branch")) gh("POST", `${r}/environments/${name}/deployment-branch-policies`, { name: branch, type: "branch" });
  } else if (step.upsertVariable) {
    const { name } = step.upsertVariable;
    const exists = gh("GET", `${r}/actions/variables`).variables.some((v) => v.name === name);
    if (exists) gh("PATCH", `${r}/actions/variables/${name}`, step.upsertVariable);
    else gh("POST", `${r}/actions/variables`, step.upsertVariable);
  } else {
    gh(step.method, step.path, step.body);
  }
}

const firstLine = (err) => String(err.stderr || err.message).trim().split("\n")[0];

function main() {
  const { values } = parseArgs({ options: { repo: { type: "string" }, "dry-run": { type: "boolean" } }, strict: true });
  let repo = values.repo;
  try {
    repo ??= execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    console.error(`configure-github: cannot resolve the repository with gh (${firstLine(err)}). Pass --repo owner/name.`);
    return 2;
  }
  if (!isRepo(repo)) {
    console.error(`configure-github: "${repo}" is not an owner/name repository.`);
    return 2;
  }

  // While template/ exists the repository is the uninitialized template, whose release.yml must stay off:
  // turning it on would release the template itself.
  const release = existsSync(join(ROOT, ".github/workflows/release.yml")) && !existsSync(join(ROOT, "template"));
  const dir = join(ROOT, ".github/workflows");
  const environments = release ? deploymentEnvironments(Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8")]))) : [];
  let defaultBranch = "main";
  if (environments.length > 0) {
    try {
      defaultBranch = gh("GET", `repos/${repo}`).default_branch;
    } catch (err) {
      if (!values["dry-run"]) {
        console.error(`configure-github: cannot read ${repo}'s default branch (${firstLine(err)}).`);
        return 2;
      }
      defaultBranch = "<default branch>";
    }
  }
  const steps = plan(repo, { release, environments, defaultBranch });
  if (values["dry-run"]) {
    console.log(`configure-github: dry run for ${repo}; nothing is changed.\n`);
    for (const step of steps) {
      const request = step.upsertRuleset ? `upsert repos/${repo}/rulesets`
        : step.upsertEnvironment ? `upsert repos/${repo}/environments/${step.upsertEnvironment.name}, one branch policy`
        : step.upsertVariable ? `upsert repos/${repo}/actions/variables`
          : `${step.method} ${step.path}`;
      console.log(`  ${step.name}${step.optional ? " (optional)" : ""}\n    ${request}${step.body ? ` ${JSON.stringify(step.body)}` : ""}`);
    }
    return 0;
  }

  let failed = 0;
  console.log(`configure-github: ${repo}`);
  for (const step of steps) {
    try {
      apply(repo, step);
      console.log(`  ✔ ${step.name}`);
    } catch (err) {
      if (step.optional) {
        console.log(`  – ${step.name}: unavailable (${firstLine(err)})`);
      } else {
        failed++;
        console.log(`  ✘ ${step.name}: ${firstLine(err)}`);
      }
    }
  }
  console.log(failed === 0 ? "\nconfigure-github: OK" : `\nconfigure-github: ${failed} required setting(s) failed`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`configure-github: ${err.message}`);
    process.exitCode = 2;
  }
}
