/**
 * Reads scripts/rules/task-rules.json, the one statement of the task rules. Lives beside the file so
 * that every check that needs the rules has them, whichever modules a project kept.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_FILE = join(dirname(fileURLToPath(import.meta.url)), "task-rules.json");

/** The rules, without the `$`-keyed notes that explain them. */
export function loadRules(file = RULES_FILE) {
  return Object.fromEntries(Object.entries(JSON.parse(readFileSync(file, "utf8"))).filter(([key]) => !key.startsWith("$")));
}
