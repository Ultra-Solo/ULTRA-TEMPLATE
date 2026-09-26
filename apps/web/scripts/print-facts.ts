// Prints the facts this module repeats as JSON, for scripts/check-facts.mjs to compare with the files that
// state them: the task rules, and the port the dev server proxies /api to. Run with `npm run --silent facts`.
import { API_DEFAULT_PORT } from "../api-proxy.ts";
import { nextStatuses, STATUSES } from "../src/features/tasks/model.ts";

const transitions = Object.fromEntries(STATUSES.map((status) => [status, nextStatuses(status)]));
console.log(JSON.stringify({ statuses: STATUSES, transitions, apiDefaultPort: API_DEFAULT_PORT }));
