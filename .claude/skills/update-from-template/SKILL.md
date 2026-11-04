---
name: update-from-template
description: Bring changes from a newer commit of the template this project was generated from — fixes to the checks, workflows, services or docs it was generated with. Use when asked to update from the template, or when a template change describes a fix this project needs.
---

# Update from the template

This project was generated from a repository template and keeps none of its history, so template changes cannot be merged directly. `scripts/template-update.mjs` recomputes them instead: it verifies and generates the exact recorded source and the newer commit, and applies the difference with a three-way merge.

1. **Find where the project stands.** Read `.template-provenance.json` for the current commit, upstream and original generation inputs. A legacy project without that file needs a reviewed `--legacy-commit <full-sha>`; nothing else can identify main-derived output. Use the target commit's new updater and `scripts/template-source.mjs`, committed before migration. Do not guess a baseline from the adopter's HEAD. Read the template's commits from the recorded one to the one you are moving to, and say in one line what the update brings. Updates only move forward; the script refuses a target that does not descend from the recorded commit.
2. **Start clean.** Commit or stash everything first; the script refuses a dirty working tree so the update can be reviewed and undone on its own. Work on a branch.
3. **Look first.** `node scripts/template-update.mjs --to <full-sha> --dry-run` lists every file that would change. Files the project deleted are skipped and named.
4. **Apply.** `node scripts/template-update.mjs --to <full-sha>`. Exit 0 applied cleanly, 1 applied with conflicts, 2 could not run. It works on the whole repository from any directory in it, and prints the baseline and target commits before running. Original identity, description, features and copyright year come from the provenance record. Repository or package renames stay adopter edits. For a reviewed legacy migration, identity defaults still come from package.json/origin and flags fill missing values. The target must descend from the saved baseline commit; `--to-commit <full-sha>` optionally pins it. `--to latest` takes the newest upstream commit.
5. **Resolve conflicts as a merge, not a choice of side.** A conflict means the project and the template both changed the same lines. Keep the project's intent and the template's fix; if you cannot tell what the template's change is for, read its pull request before deciding.
6. **Prove it.** `node scripts/setup.mjs`, then `node scripts/verify.mjs`. A template update can change checks as well as code, so a check that now fails may have found something real in this project — fix that rather than reverting the check.
7. **Land it as its own pull request**, titled `chore: update from the template to <short-sha>`. The script has already updated `.template-provenance.json`; keep it, because the next update starts from there.

Skip a commit only by moving to a later one: updates are cumulative, and the script computes the whole difference between any two commits.

## Changing which features this project has

The same script adds or removes features, at the commit the project is on, or together with a commit move when `--to` is given too.

1. **Look first.** `node scripts/template-update.mjs --add web --dry-run` (or `--remove py-service`) lists every file that would arrive or go. Ids are comma-separated, as init's `--features` are.
2. **Clear the way for a removal.** It is refused, with each path named, when it would delete a file the project changed or leave a file of the project's own inside the feature's directory. Decide where that work belongs, move or delete it in its own commit, then run the removal again.
3. **Apply, then prove it**, as above: `node scripts/setup.mjs`, `node scripts/verify.mjs`. An added module arrives without its dependencies installed.
4. **Land it as its own pull request**, titled `feat: add <feature> from the template` or `chore: remove <feature>`. Keep the updated `.template-provenance.json` in the same commit; the next update reads the machine record.
