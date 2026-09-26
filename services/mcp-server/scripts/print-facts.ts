// Prints the facts this module repeats as JSON, for scripts/check-facts.mjs to compare with the files that
// state them: the task rules, and the port of the task API it calls by default. Run with
// `npm run --silent facts`.
import { DEFAULT_TASK_API_URL } from "../src/config.ts";
import { MAX_TITLE_LENGTH, nextStatuses, STATUSES, TITLE_WHITESPACE } from "../src/domain/task.ts";

const transitions = Object.fromEntries(STATUSES.map((status) => [status, nextStatuses(status)]));
const apiDefaultPort = Number(new URL(DEFAULT_TASK_API_URL).port);
console.log(
  JSON.stringify({ statuses: STATUSES, transitions, maxTitleLength: MAX_TITLE_LENGTH, titleWhitespace: TITLE_WHITESPACE, apiDefaultPort }),
);
