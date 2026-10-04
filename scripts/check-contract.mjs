/**
 * The task API contract, checked against each task service over HTTP and at startup.
 *
 * The services are the same API in three languages, and "identical behaviour" is the claim the whole
 * structure rests on (ADR-0008). Each service's own tests were written separately, and they drifted:
 * the first run of this check found six requests the services answered differently, and its first run
 * over configuration found values one service took and the others refused. So the cases live once, in
 * scripts/contract/tasks-api.json, and every service is held to them — not to each other, so a project
 * that keeps only one service still checks it.
 *
 * It talks to a service only over HTTP and through its environment, stdout and exit code, the ways
 * modules may integrate (ADR-0004): it starts the service on a free port, waits until it is ready, sends
 * every case, and stops it; then it starts it once for each configuration value the contract lists.
 *
 *   node scripts/check-contract.mjs              # every task service present
 *   node scripts/check-contract.mjs py-service   # one
 *   node scripts/check-contract.mjs --e2e mcp-server [--service ts-service]
 *
 * `--e2e` starts a task service (the one named, or e2ePartner's choice) and runs a client module's own
 * end-to-end command against it: its module.json `e2e.run`, with `{taskApi}` replaced by the service's
 * address. The client drives the real API with its own dependencies, so this script needs none.
 *
 * Exit 0 every case matched · 1 a service answered differently · 2 a service could not be started,
 * or a name is not a task service present here.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { e2ePartner, presentModules, ROOT, run } from "./modules.mjs";
import { loadRules } from "./rules/load.mjs";

export const CASES_FILE = join(ROOT, "scripts", "contract", "tasks-api.json");
export const SPEC_FILE = join(ROOT, "scripts", "contract", "openapi.json");
/** The fields of a task, as every service answers with them and the OpenAPI document states them. */
export const TASK_FIELDS = ["createdAt", "id", "status", "title", "updatedAt"];
const STARTUP_MS = 60_000;
const LOG_WAIT_MS = 3_000;

export const loadContract = (file = CASES_FILE) => JSON.parse(readFileSync(file, "utf8"));
export const loadCases = (file = CASES_FILE) => loadContract(file).cases;
export const loadSpec = (file = SPEC_FILE) => JSON.parse(readFileSync(file, "utf8"));
/** What a case may refer to: the task rules and the contract's limits. */
export const loadFacts = (contract = loadContract(), rules = loadRules()) => ({ rules, limits: contract.limits });

/** The variables of a contract's `config`, as [name, spec] pairs. */
const variables = (config) => Object.entries(config).filter(([name]) => !name.startsWith("$"));

/**
 * A number the contract states as `{ "ref": "limits.maxBodyBytes", "plus": 1 }`: a path into the facts
 * plus an offset. Anything else is refused, a plain number included: a count written out is a limit
 * restated, and it stops testing the bound the day the limit moves.
 */
export function resolveRef(value, facts) {
  if (value === null || typeof value !== "object" || typeof value.ref !== "string") {
    throw new Error(`a count must be { "ref": … }, not ${JSON.stringify(value)}: refer to the limit or rule it tests`);
  }
  const found = value.ref.split(".").reduce((at, key) => (at !== null && typeof at === "object" ? at[key] : undefined), facts);
  if (typeof found !== "number") throw new Error(`${value.ref} names no number in the contract's limits or the task rules`);
  return found + (value.plus ?? 0);
}

/** The pattern a request id must match to be echoed, from the contract's limits. */
export const requestIdPattern = ({ requestId }) => new RegExp(`^[${requestId.characters}]{1,${requestId.maxLength}}$`);

/** Follows a local `$ref` such as `#/components/schemas/Task`. */
const deref = (spec, node) =>
  node?.$ref
    ? node.$ref
        .slice(2)
        .split("/")
        .reduce((at, key) => at?.[key], spec)
    : node;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * The documented path a request's path falls under, the operation for its method there (undefined when
 * the path does not list it, HEAD answering as GET), and the methods a 405 must name in `Allow`: the
 * listed ones, with HEAD wherever GET is. Undefined for a path the document does not describe.
 */
export function operationFor(spec, method, path) {
  const segments = path.split("?")[0].split("/");
  const template = Object.keys(spec.paths ?? {}).find((t) => {
    const parts = t.split("/");
    return (
      parts.length === segments.length && parts.every((part, i) => (/^\{.+\}$/.test(part) ? segments[i] !== "" : part === segments[i]))
    );
  });
  if (template === undefined) return undefined;
  const item = spec.paths[template];
  const listed = HTTP_METHODS.filter((m) => m in item).map((m) => m.toUpperCase());
  const allow = [...new Set([...listed, ...(listed.includes("GET") ? ["HEAD"] : [])])].sort();
  return { template, operation: item[method === "HEAD" ? "get" : method.toLowerCase()], allow };
}

const kindOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const isType = (type, value) =>
  type === "integer" ? Number.isInteger(value) : type === "object" ? kindOf(value) === "object" : kindOf(value) === type;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Where `value` breaks `schema`, or an empty list: the subset of JSON Schema the document uses. `$ref`,
 * `type` (one or a list), `const`, `enum`, `pattern`, `minLength` and `maxLength` counted in code points
 * as the task rules count a title, `format: date-time` as RFC 3339 writes it, `required`, `properties`,
 * `additionalProperties: false` and `items`. `at` names the place, as `$.createdAt` or `$[0].id`.
 */
export function conforms(spec, schema, value, at = "$") {
  const node = deref(spec, schema);
  if (node === undefined || node === null) return [];
  const types = node.type === undefined ? [] : [node.type].flat();
  if (types.length > 0 && !types.some((type) => isType(type, value))) return [`${at} is a ${kindOf(value)}, not ${types.join(" or ")}`];
  const problems = [];
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node.const))
    problems.push(`${at} is ${JSON.stringify(value)}, not ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
    problems.push(`${at} is ${JSON.stringify(value)}, not one of ${JSON.stringify(node.enum)}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (node.maxLength !== undefined && length > node.maxLength)
      problems.push(`${at} is ${length} characters, more than ${node.maxLength}`);
    if (node.minLength !== undefined && length < node.minLength)
      problems.push(`${at} is ${length} characters, fewer than ${node.minLength}`);
    if (node.pattern !== undefined && !new RegExp(node.pattern, "u").test(value))
      problems.push(`${at} ${JSON.stringify(value).slice(0, 80)} does not match ${node.pattern}`);
    if (node.format === "date-time" && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))))
      problems.push(`${at} is not a date-time: ${JSON.stringify(value).slice(0, 40)}`);
  }
  if (kindOf(value) === "object") {
    for (const key of node.required ?? []) if (!(key in value)) problems.push(`${at} has no ${key}, which is required`);
    for (const [key, field] of Object.entries(value)) {
      if (node.properties && key in node.properties) problems.push(...conforms(spec, node.properties[key], field, `${at}.${key}`));
      else if (node.additionalProperties === false) problems.push(`${at} has ${key}, which the schema does not allow`);
    }
  }
  if (Array.isArray(value) && node.items) value.forEach((item, i) => problems.push(...conforms(spec, node.items, item, `${at}[${i}]`)));
  return problems;
}

/**
 * Where the OpenAPI document and the contract disagree, or an empty list. The document is a
 * description of the API that clients can read; the cases are what every service is proved against. So
 * each is held to the other: every case sent to a documented operation answers with a status the
 * document lists, every listed response is exercised by a case, a method a documented path does not
 * list is answered 405, the schemas state the fields the services answer with and the statuses and
 * title length of scripts/rules/task-rules.json, and the request id pattern and body limit are the
 * contract's limits.
 */
export function checkSpec(spec, contract, rules) {
  const { cases, limits } = contract;
  const problems = [];
  const templates = Object.keys(spec.paths ?? {});
  const exercised = new Set();
  for (const c of cases) {
    const found = operationFor(spec, c.method, c.path);
    if (found === undefined) continue; // outside the API: answered 404, which the document says of any path
    const { template: path, operation } = found;
    const method = c.method === "HEAD" ? "get" : c.method.toLowerCase();
    if (operation === undefined) {
      if (c.status !== 405)
        problems.push(
          `case "${c.name}" sends ${c.method} to ${path}, which the document does not list, and expects ${c.status} rather than 405`,
        );
    } else if (!(String(c.status) in operation.responses)) {
      problems.push(`case "${c.name}": ${c.method} ${path} answers ${c.status}, which the document does not list`);
    } else {
      exercised.add(`${method} ${path} ${c.status}`);
    }
  }
  for (const path of templates) {
    for (const [method, operation] of Object.entries(spec.paths[path])) {
      for (const code of Object.keys(operation?.responses ?? {})) {
        if (!exercised.has(`${method} ${path} ${code}`))
          problems.push(`the document lists ${code} for ${method.toUpperCase()} ${path}, which no case exercises`);
      }
    }
  }
  const schemas = spec.components?.schemas ?? {};
  const fields = Object.keys(schemas.Task?.properties ?? {})
    .sort()
    .join(",");
  if (fields !== TASK_FIELDS.join(",")) problems.push(`the Task schema has fields ${fields}, expected ${TASK_FIELDS.join(",")}`);
  const statuses = deref(spec, schemas.Task?.properties?.status)?.enum;
  if (JSON.stringify(statuses) !== JSON.stringify(rules.statuses)) {
    problems.push(`the Status enum is ${JSON.stringify(statuses)}, expected ${JSON.stringify(rules.statuses)}`);
  }
  for (const [name, title] of [
    ["Task", schemas.Task?.properties?.title],
    ["CreateTask", schemas.CreateTask?.properties?.title],
  ]) {
    if (title?.maxLength !== rules.maxTitleLength)
      problems.push(`the ${name} title maxLength is ${title?.maxLength}, expected ${rules.maxTitleLength}`);
  }
  const pattern = spec.components?.headers?.RequestId?.schema?.pattern;
  if (pattern !== requestIdPattern(limits).source)
    problems.push(`the RequestId header pattern is ${pattern}, expected ${requestIdPattern(limits).source}`);
  const bodyLimit = spec.components?.responses?.BadRequest?.["x-maxBodyBytes"];
  if (bodyLimit !== limits.maxBodyBytes)
    problems.push(`the BadRequest response's x-maxBodyBytes is ${bodyLimit}, expected ${limits.maxBodyBytes}`);
  return problems;
}

const withProperty = new Map();
/** Every code point with the Unicode property `name`, as one string, in code point order. */
export function codePointsWith(name) {
  if (!withProperty.has(name)) {
    const test = new RegExp(`^\\p{${name}}$`, "u");
    let found = "";
    for (let cp = 0; cp <= 0x10ffff; cp++)
      if ((cp < 0xd800 || cp > 0xdfff) && test.test(String.fromCodePoint(cp))) found += String.fromCodePoint(cp);
    withProperty.set(name, found);
  }
  return withProperty.get(name);
}

/**
 * A value a case builds rather than writes: `{ repeat, times }` repeats a string, and
 * `{ whitespace: "rules.titleWhitespace", around }` is every character with the Unicode property the
 * rules name, on both sides of `around` (or alone), so the cases follow the rule rather than a list.
 */
function expand(value, facts) {
  if (value === null || typeof value !== "object") return value;
  if ("repeat" in value) return value.repeat.repeat(resolveRef(value.times, facts));
  if ("whitespace" in value) {
    const name = value.whitespace.split(".").reduce((at, key) => at?.[key], facts);
    if (typeof name !== "string") throw new Error(`${value.whitespace} names no Unicode property in the task rules`);
    const all = codePointsWith(name);
    return value.around === undefined ? all : `${all}${value.around}${all}`;
  }
  return value;
}

/**
 * A body is a string sent as written, or an object whose `{ repeat, times }` values are expanded first.
 * `padTo` then fills it with trailing spaces, which JSON allows, to exactly that many bytes.
 */
export function encodeBody(body, facts, padTo) {
  const text =
    body === undefined || typeof body === "string"
      ? body
      : JSON.stringify(Object.fromEntries(Object.entries(body).map(([key, value]) => [key, expand(value, facts)])));
  if (padTo === undefined) return text;
  const size = resolveRef(padTo, facts);
  const used = Buffer.byteLength(text ?? "");
  if (used > size) throw new Error(`the body is already ${used} bytes, more than the ${size} it is padded to`);
  return `${text ?? ""}${" ".repeat(size - used)}`;
}

/** A case's headers, with `{ repeat, times }` values expanded as in a body. */
const encodeHeaders = (headers, facts) =>
  Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key, expand(value, facts)]));

function send(base, { method, path, body, bodyHex, padTo, headers: extra, contentType = "application/json" }, facts) {
  const url = new URL(base);
  // `bodyHex` is for a body whose bytes are the point: a byte-order mark, UTF-16, bytes that are not UTF-8.
  const payload = bodyHex === undefined ? encodeBody(body, facts, padTo) : Buffer.from(bodyHex, "hex");
  const headers = {
    ...encodeHeaders(extra, facts),
    ...(payload === undefined ? {} : { "content-type": contentType, "content-length": Buffer.byteLength(payload) }),
  };
  return new Promise((resolve, reject) => {
    // node:http rather than fetch: fetch refuses a body on some methods and normalizes the path.
    const req = request({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          type: String(res.headers["content-type"] ?? ""),
          requestId: res.headers["x-request-id"],
          allow: res.headers.allow,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * What is wrong with one answer, or an empty list. With the OpenAPI document, a JSON answer must also
 * fit the schema it documents for that status, and a 405 must name in `Allow` the methods it lists.
 */
export function judge(testCase, answer, facts, spec) {
  const problems = [];
  if (answer.status !== testCase.status) problems.push(`status ${answer.status}, expected ${testCase.status}`);
  const body = parse(answer.text);
  if (testCase.error && typeof body?.error !== "string") problems.push(`no {"error": "..."} body: ${answer.text.slice(0, 80)}`);
  if (testCase.array && !Array.isArray(body)) problems.push("body is not a JSON array");
  if (testCase.json && JSON.stringify(body) !== JSON.stringify(testCase.json)) problems.push(`body ${answer.text.slice(0, 80)}`);
  if (testCase.task) {
    const keys = Object.keys(body ?? {})
      .sort()
      .join(",");
    if (keys !== TASK_FIELDS.join(",")) problems.push(`task fields ${keys}`);
    for (const [key, value] of Object.entries(testCase.task)) {
      if (body?.[key] !== value) problems.push(`${key} ${JSON.stringify(body?.[key])}, expected ${JSON.stringify(value)}`);
    }
  }
  if ((testCase.error || testCase.array || testCase.json || testCase.task) && !answer.type.startsWith("application/json")) {
    problems.push(`content-type ${answer.type || "missing"}`);
  }
  // The language's own server may refuse a request before the service sees it, and then only it answers.
  if (!testCase.beforeService && !requestIdPattern(facts.limits).test(answer.requestId ?? ""))
    problems.push("no usable X-Request-Id header");
  const sent = expand(Object.entries(testCase.headers ?? {}).find(([key]) => key.toLowerCase() === "x-request-id")?.[1], facts);
  if (testCase.requestId === "echo" && answer.requestId !== sent) {
    problems.push(
      `X-Request-Id ${JSON.stringify(answer.requestId)?.slice(0, 80)}, expected the ${JSON.stringify(sent).slice(0, 80)} that was sent`,
    );
  }
  if (testCase.requestId === "replaced" && answer.requestId === sent)
    problems.push(`X-Request-Id echoes ${JSON.stringify(sent).slice(0, 80)}, which is not a usable id`);
  const found = spec === undefined ? undefined : operationFor(spec, testCase.method, testCase.path);
  if (found && answer.status === 405) {
    const allow = String(answer.allow ?? "")
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean)
      .sort();
    if (allow.join() !== found.allow.join())
      problems.push(`Allow ${JSON.stringify(answer.allow ?? "")}, expected ${JSON.stringify(found.allow.join(", "))}`);
  }
  if (found?.operation && testCase.method !== "HEAD" && body !== undefined) {
    const schema = deref(spec, found.operation.responses?.[String(answer.status)])?.content?.["application/json"]?.schema;
    if (schema) problems.push(...conforms(spec, schema, body).slice(0, 5));
  }
  return problems;
}

/**
 * Where the service's stdout disagrees with the requests it answered, or an empty list. Every line is
 * JSON, and every answered request with an id is logged exactly once, with the method, the path without
 * its query string and the status it was answered with, a non-negative durationMs, a parseable time and
 * the level "info". Lines for other requests, such as the readiness polls at startup, are allowed.
 */
export function checkLogs(exchanges, stdout) {
  const problems = [];
  const lines = [];
  for (const text of stdout.split(/\r?\n/).filter((l) => l.trim() !== "")) {
    try {
      lines.push(JSON.parse(text));
    } catch {
      problems.push(`stdout line is not JSON: ${text.slice(0, 80)}`);
    }
  }
  const uses = new Map();
  for (const exchange of exchanges) uses.set(exchange.requestId, (uses.get(exchange.requestId) ?? 0) + 1);
  for (const [id, count] of uses)
    if (count > 1) problems.push(`request id ${id} was given to ${count} responses, so their log lines cannot be told apart`);
  for (const { requestId, method, path, status } of exchanges.filter((e) => uses.get(e.requestId) === 1)) {
    const logged = lines.filter((line) => line?.msg === "request" && line.requestId === requestId);
    if (logged.length !== 1) {
      problems.push(`request ${requestId.slice(0, 80)} (${method} ${path}) was logged ${logged.length} times, expected once`);
      continue;
    }
    const [line] = logged;
    const wrong = [];
    if (line.method !== method) wrong.push(`method ${JSON.stringify(line.method)}, expected ${method}`);
    if (line.path !== path) wrong.push(`path ${JSON.stringify(line.path)}, expected ${path}`);
    if (line.status !== status) wrong.push(`status ${JSON.stringify(line.status)}, expected ${status}`);
    if (typeof line.durationMs !== "number" || line.durationMs < 0) wrong.push(`durationMs ${JSON.stringify(line.durationMs)}`);
    if (typeof line.time !== "string" || Number.isNaN(Date.parse(line.time))) wrong.push(`time ${JSON.stringify(line.time)}`);
    if (line.level !== "info") wrong.push(`level ${JSON.stringify(line.level)}`);
    if (wrong.length > 0) problems.push(`request ${requestId} logged ${wrong.join(", ")}`);
  }
  return problems;
}

/**
 * Runs every case against a service already listening at `base`. Returns the mismatches.
 *
 * A case may list `setup` requests, sent first to bring its task to the state the case is about, such
 * as a task already done. Each is judged on its status alone. One that does not land is reported as
 * itself and the case is not sent: a service that cannot reach a state has not answered the question
 * asked from it.
 */
export async function runCases(base, cases, { exchanges = [], facts = loadFacts(), spec } = {}) {
  const failures = [];
  // Every request a case sends, the ones that stage it included, is recorded for checkLogs.
  const exchange = async (request) => {
    const answer = await send(base, request, facts);
    if (typeof answer.requestId === "string") {
      exchanges.push({ requestId: answer.requestId, method: request.method, path: request.path.split("?")[0], status: answer.status });
    }
    return answer;
  };
  for (const testCase of cases) {
    const setup = testCase.setup ?? [];
    let id;
    if ([testCase, ...setup].some((request) => request.path.includes("{id}"))) {
      const created = await exchange({ method: "POST", path: "/api/tasks", body: '{"title":"contract"}' });
      id = parse(created.text)?.id;
      if (created.status !== 201 || typeof id !== "string") {
        failures.push({ name: testCase.name, problems: [`could not create the task this case needs (${created.status})`] });
        continue;
      }
    }
    const resolve = (path) => (id === undefined ? path : path.replace("{id}", encodeURIComponent(id)));
    let staged = true;
    for (const [index, step] of setup.entries()) {
      const path = resolve(step.path);
      const answer = await exchange({ ...step, path }).catch(() => null);
      if (answer?.status !== step.status) {
        failures.push({
          name: testCase.name,
          problems: [
            `setup ${index + 1} (${step.method} ${path}) answered ${answer?.status ?? "with invalid HTTP"}, expected ${step.status}`,
          ],
        });
        staged = false;
        break;
      }
    }
    if (!staged) continue;
    const created = [];
    for (const n of testCase.oldestFirst ? [1, 2, 3] : []) {
      created.push(parse((await exchange({ method: "POST", path: "/api/tasks", body: `{"title":"oldest first ${n}"}` })).text)?.id);
    }
    const path = resolve(testCase.path);
    let answers;
    try {
      // The same request sent at once, `concurrent` times: what a store that reads and then writes gets wrong.
      answers = await Promise.all(Array.from({ length: testCase.concurrent ?? 1 }, () => exchange({ ...testCase, path })));
    } catch (err) {
      // A response the client cannot parse — a body on a HEAD response, say — is a failed case,
      // not a crash of the check.
      failures.push({ name: testCase.name, problems: [`not valid HTTP: ${err.code ?? err.message}`] });
      continue;
    }
    const problems = [];
    let answer = answers[0];
    if (testCase.concurrent !== undefined) {
      const winners = answers.filter((a) => a.status === testCase.status);
      const others = answers.filter((a) => a.status !== testCase.status && a.status !== testCase.othersStatus).map((a) => a.status);
      if (winners.length !== 1)
        problems.push(`${winners.length} of ${answers.length} concurrent requests answered ${testCase.status}, expected exactly 1`);
      if (others.length > 0) problems.push(`the others answered ${[...new Set(others)].join(", ")}, expected ${testCase.othersStatus}`);
      answer = winners[0] ?? answer;
    }
    problems.push(...judge(testCase, answer, facts, spec));
    if (testCase.oldestFirst) {
      const listed = (parse(answer.text) ?? []).map?.((task) => task?.id).filter((id) => created.includes(id)) ?? [];
      if (listed.join() !== created.join())
        problems.push(`lists the tasks it created as ${listed.join(", ")}, not in the order they were created (${created.join(", ")})`);
    }
    if (problems.length > 0) failures.push({ name: testCase.name, problems });
  }
  return failures;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function slowExchange(base, parts, intervalMs, closeAfterMs) {
  const url = new URL(base);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  let response = "";
  let closed = false;
  socket.on("data", (chunk) => (response += chunk.toString("latin1")));
  socket.on("error", () => {});
  const ended = new Promise((resolve) =>
    socket.once("close", () => {
      closed = true;
      resolve(true);
    }),
  );
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      if (await Promise.race([ended, pause(intervalMs).then(() => false)])) break;
    }
    if (!socket.destroyed) socket.write(part);
  }
  const didClose = closed || (await Promise.race([ended, pause(closeAfterMs).then(() => false)]));
  if (!didClose) socket.destroy();
  const status = /^HTTP\/\d\.\d (\d{3})/.exec(response)?.[1];
  return { closed: didClose, status: status === undefined ? undefined : Number(status) };
}

/** Slow trickles that stay within the contract are accepted; ones past it are terminated. */
export async function checkReceiveTimeouts(base, timeouts) {
  const header = [Buffer.from("GET /healthz HTTP/1.1\r\n"), Buffer.from("Host: localhost\r\nConnection: close\r\n"), Buffer.from("\r\n")];
  const body = Buffer.from('{"title":"slow"}');
  const bodyHead = Buffer.from(
    `POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  const bodyParts = [Buffer.concat([bodyHead, body.subarray(0, 1)]), body.subarray(1, 2), body.subarray(2)];
  const tests = [
    ["headers arrive before the deadline", header, Math.ceil(timeouts.headers * 0.3), 200],
    ["slow headers exceed the deadline", header, Math.ceil(timeouts.headers * 0.6), undefined],
    ["body arrives before the deadline", bodyParts, Math.ceil(timeouts.request * 0.4), 201],
    ["slow body exceeds the deadline", bodyParts, Math.ceil(timeouts.request * 0.55), undefined],
  ];
  const results = await Promise.all(
    tests.map(async ([name, parts, intervalMs, expected]) => ({
      name,
      expected,
      result: await slowExchange(base, parts, intervalMs, Math.max(50, Math.min(1000, timeouts.request * 0.1))),
    })),
  );
  return results.flatMap(({ name, expected, result }) => {
    const problems = [];
    if (!result.closed) problems.push("connection remained open after the request finished or its deadline passed");
    if (expected === undefined) {
      if (result.status !== undefined && result.status >= 200 && result.status < 300)
        problems.push(`answered ${result.status} after the receive deadline`);
    } else if (result.status !== expected) {
      problems.push(`status ${result.status ?? "missing"}, expected ${expected}`);
    }
    return problems.length === 0 ? [] : [{ name: `receive timeout: ${name}`, problems }];
  });
}

// Where each script's digits start in Unicode: `{port:<script>}` writes the port in them.
const DIGIT_ZERO = { fullwidth: 0xff10, "arabic-indic": 0x0660 };

/** A configuration value with `{port}` filled in, in ASCII digits or, as `{port:fullwidth}`, another script's. */
export function fillPort(text, port) {
  return text.replace(/\{port(?::([a-z-]+))?\}/g, (_, script) => {
    if (script === undefined) return String(port);
    if (!(script in DIGIT_ZERO)) throw new Error(`unknown digits {port:${script}}; known: ${Object.keys(DIGIT_ZERO).join(", ")}`);
    return [...String(port)].map((digit) => String.fromCodePoint(DIGIT_ZERO[script] + Number(digit))).join("");
  });
}

/**
 * Every configuration case the contract states. An unset and an empty variable read as its default,
 * and so does its default written out; a variable that binds a port has those checked by CI's image
 * probe instead, since checking them here would bind that port on the machine running the check.
 */
export function configCases(config) {
  const cases = [];
  for (const [variable, spec] of variables(config)) {
    if (!spec.binds) {
      for (const value of [undefined, "", spec.default.value])
        cases.push({ variable, value, accept: true, effective: spec.default.effective });
    }
    for (const { value, effective } of spec.accept) cases.push({ variable, value, accept: true, effective });
    for (const value of spec.refuse) cases.push({ variable, value, accept: false });
  }
  return cases;
}

export const configCaseName = ({ variable, value }) => (value === undefined ? `${variable} unset` : `${variable}=${JSON.stringify(value)}`);

/**
 * The environment a service starts with: a variable that binds a port set to a free one, every other
 * contract variable unset, so a value in the shell that runs the check cannot leak in, and then the
 * configuration case under test, if any, set to its value or unset.
 */
export function configEnv(config, testCase, port, base = process.env) {
  const env = { ...base };
  for (const [variable, spec] of variables(config)) {
    delete env[variable];
    if (spec.binds) env[variable] = String(port);
  }
  if (testCase && testCase.value === undefined) delete env[testCase.variable];
  else if (testCase) env[testCase.variable] = fillPort(testCase.value, port);
  return env;
}

/** What the listening line must report for a case started on `port`: each variable's value in effect. */
export function expectedReport(config, testCase, port) {
  return Object.fromEntries(
    variables(config).map(([variable, spec]) => {
      const value = variable === testCase.variable ? testCase.effective : spec.binds ? "{port}" : spec.default.effective;
      return [spec.reportedAs, value === "{port}" ? port : value];
    }),
  );
}

// Durations reach the listening line through each language's floating point.
const near = (a, b) => typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * What is wrong with how a service started for one configuration case, or an empty list. `outcome` holds
 * its stdout lines parsed as JSON, the listening line if it wrote one, and its exit code if it exited.
 */
export function judgeStartup({ config, startup }, testCase, port, outcome) {
  const refusal = outcome.lines.find((line) => line?.level === startup.refused.level && line?.msg === startup.refused.msg);
  if (testCase.accept) {
    if (!outcome.listening) {
      const why = refusal ? `: ${refusal.error}` : outcome.stderr ? `: ${outcome.stderr.trim().split("\n").at(-1)}` : "";
      return [outcome.exitCode === null ? "wrote no listening line" : `exited ${outcome.exitCode} instead of starting${why}`.slice(0, 300)];
    }
    return Object.entries(expectedReport(config, testCase, port))
      .filter(([field, want]) => !near(outcome.listening[field], want))
      .map(([field, want]) => `the listening line reports ${field} ${JSON.stringify(outcome.listening[field])}, expected ${want}`);
  }
  if (outcome.listening) return [`started, reporting ${JSON.stringify(outcome.listening).slice(0, 160)}, where it must refuse the value`];
  const problems = [];
  if (outcome.exitCode !== startup.refused.exitCode) problems.push(`exited ${outcome.exitCode}, expected ${startup.refused.exitCode}`);
  if (!refusal) problems.push(`wrote no ${JSON.stringify({ level: startup.refused.level, msg: startup.refused.msg })} line to stdout`);
  else if (typeof refusal.error !== "string" || !refusal.error.includes(testCase.variable))
    problems.push(`its error ${JSON.stringify(refusal.error)} does not name ${testCase.variable}`);
  return problems;
}

/**
 * Where a service's Dockerfile disagrees with the contract: the image must EXPOSE the default of every
 * variable that binds a port, and must not set a contract variable, which would change the default the
 * contract states for every service.
 */
export function checkImage(dockerfile, config) {
  const lines = dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const exposed = lines.flatMap(
    (line) =>
      /^\s*EXPOSE\s+(.+)$/i
        .exec(line)?.[1]
        .trim()
        .split(/\s+/)
        .map((port) => port.split("/")[0]) ?? [],
  );
  const set = lines.flatMap((line) => /^\s*ENV\s+(.+)$/i.exec(line)?.[1].match(/[A-Za-z_][A-Za-z0-9_]*(?==|\s)/g) ?? []);
  const problems = [];
  for (const [variable, spec] of variables(config)) {
    if (spec.binds && !exposed.includes(spec.default.value))
      problems.push(`the Dockerfile exposes ${exposed.join(", ") || "no port"}, but ${variable} defaults to ${spec.default.value}`);
    if (set.includes(variable)) problems.push(`the Dockerfile sets ${variable}, so the image's default is not the contract's`);
  }
  return problems;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// Configuration cases run four at a time, and a case's port is free between the probe and the
// service's bind. A kernel hands a port the probe just closed to the next bind(0) — on CI's kernel
// for long enough that two cases were handed the same port, and the service that bound second
// crashed with EADDRINUSE. So every case probes its own slot below the ephemeral range, where the
// kernel never allocates a port on its own, and skips a candidate another process holds.
const CONFIG_PORT_BASE = 24_001;
const CONFIG_PORT_SLOTS = 8;

/** A free port among a case's `CONFIG_PORT_SLOTS` candidates, or null when another process holds them all. */
export async function freePortNear(base) {
  for (let candidate = base; candidate < base + CONFIG_PORT_SLOTS; candidate++) {
    const free = await new Promise((resolve) => {
      const server = createServer();
      server.on("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  return null;
}

/**
 * The placeholders a module's `taskApi` commands may use: a scratch directory for a build, and the
 * platform's executable suffix. Anything else in braces is a mistake in the manifest, and is refused.
 */
export function expandCommand(command, vars) {
  return command.map((part) =>
    part.replace(/\{(\w+)\}/g, (_, name) => {
      if (!(name in vars)) throw new Error(`unknown placeholder {${name}} in ${command.join(" ")}`);
      return vars[name];
    }),
  );
}

/** Builds the service when its manifest says how, and returns the command that starts it, or null. */
function startCommand(module, dir, scratch) {
  const vars = { scratch, exe: process.platform === "win32" ? ".exe" : "" };
  if (module.taskApi.build) {
    const [command, ...args] = expandCommand(module.taskApi.build, vars);
    if (spawnSync(command, args, { cwd: dir, stdio: "inherit" }).status !== 0) return null;
  }
  return expandCommand(module.taskApi.run, vars);
}

/** Starts the service; a tree (uv starts python) gets its own process group, so it is stopped as one. */
function start(cmd, dir, env) {
  const child = spawn(cmd[0], cmd.slice(1), { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  child.on("error", (err) => (output.stderr += String(err)));
  const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return { child, output, closed };
}

async function stop({ child, closed }) {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  const timer = setTimeout(() => {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 5_000);
  await closed;
  clearTimeout(timer);
}

async function waitForReady(base, running, ready, facts) {
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) return false;
    try {
      if ((await send(base, ready, facts)).status === ready.status) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const jsonLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map(parse);

/** Starts the service for one configuration case and waits for its listening line, its exit, or the deadline. */
async function startupOutcome(cmd, dir, env, listening) {
  const running = start(cmd, dir, env);
  const isListening = (line) => line?.level === listening.level && line?.msg === listening.msg;
  const deadline = Date.now() + STARTUP_MS;
  let exitCode = null;
  running.closed.then((code) => (exitCode = code ?? -1));
  while (Date.now() < deadline && exitCode === null && !jsonLines(running.output.stdout).some(isListening)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const lines = jsonLines(running.output.stdout);
  const outcome = { lines, listening: lines.find(isListening) ?? null, exitCode, stderr: running.output.stderr };
  await stop(running);
  return outcome;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order of the results. */
async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The shutdown cases: the variable `startup.stopped.within` names, unset (its default), at the longest
 * value it accepts, where a timer that overflows would fire at once, and at the shortest, where a request
 * that never finishes must be abandoned.
 */
export function shutdownCases({ config, startup }) {
  const variable = startup.stopped.within;
  const accepted = [...config[variable].accept].sort((a, b) => a.effective - b.effective);
  return [
    { variable, value: undefined, finishes: true },
    { variable, value: accepted.at(-1).value, finishes: true },
    { variable, value: accepted[0].value, finishes: false },
  ];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Long enough for a service to read what was sent, and for a signal to be handled.
const SETTLE_MS = 300;
const ANSWER_MS = 5_000;
const EXIT_MS = 10_000;

/** The exit code (or signal) the service ended with, or null if it is still running after `ms`. */
async function exitWithin(running, ms) {
  const timer = sleep(ms).then(() => null);
  return Promise.race([running.closed.then(() => running.child.exitCode ?? running.child.signalCode), timer]);
}

/** One shutdown case: SIGTERM with a request half sent, then what the contract says must follow. */
async function shutdownOnce(cmd, dir, contract, facts, testCase, baseEnv) {
  const { ready, stopped } = contract.startup;
  const port = await freePort();
  const running = start(cmd, dir, configEnv(contract.config, testCase, port, baseEnv));
  let socket;
  try {
    if (!(await waitForReady(`http://127.0.0.1:${port}`, running, ready, facts))) return [`did not answer ${ready.path}`];
    socket = connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    socket.on("error", () => {});
    const ended = new Promise((resolve) => socket.on("close", resolve));
    const body = '{"title":"in flight"}';
    const half = Math.floor(body.length / 2);
    socket.write(
      `POST /api/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, half)}`,
    );
    await sleep(SETTLE_MS);
    // To the process itself, as `docker stop` signals PID 1: a launcher such as uv passes it on.
    process.kill(running.child.pid, stopped.signal);
    await sleep(SETTLE_MS);
    if (!testCase.finishes) {
      const code = await exitWithin(running, EXIT_MS);
      if (code === null)
        return [`still running ${EXIT_MS / 1000}s after SIGTERM, with a request it could not finish, long after its ${testCase.variable}`];
      return code === stopped.abandoned.exitCode
        ? []
        : [`exited ${code} after giving up on a request in flight, expected ${stopped.abandoned.exitCode}`];
    }
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return [
        `exited ${running.child.exitCode ?? running.child.signalCode} with a request in flight, before its ${testCase.variable} passed`,
      ];
    }
    socket.write(body.slice(half));
    await Promise.race([ended, sleep(ANSWER_MS)]);
    const problems = [];
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1];
    if (status !== "201")
      problems.push(`answered the request in flight with ${JSON.stringify(received.split("\r\n")[0] ?? "")}, expected 201`);
    const code = await exitWithin(running, EXIT_MS);
    if (code !== stopped.exitCode)
      problems.push(
        code === null
          ? `still running ${EXIT_MS / 1000}s after answering its last request`
          : `exited ${code} after answering its last request, expected ${stopped.exitCode}`,
      );
    return problems;
  } finally {
    socket?.destroy();
    await stop(running);
  }
}

/**
 * Stops the service with a request in flight, once for each of shutdownCases, and returns what went
 * wrong. Not on Windows, where no signal a service can handle can be sent to it.
 */
export async function checkShutdown(cmd, dir, contract, facts, baseEnv = process.env) {
  const failures = [];
  for (const testCase of shutdownCases(contract)) {
    const problems = await shutdownOnce(cmd, dir, contract, facts, testCase, baseEnv);
    if (problems.length > 0) failures.push({ name: `shutdown with ${configCaseName(testCase)}`, problems });
  }
  return failures;
}

/** Starts the service once for every configuration case in the contract, and returns what went wrong. */
export async function checkConfig(cmd, dir, contract) {
  const cases = configCases(contract.config);
  const slots = cases.map((testCase, index) => [testCase, CONFIG_PORT_BASE + index * CONFIG_PORT_SLOTS]);
  const failures = await pool(slots, Math.max(1, Math.min(4, availableParallelism() - 1)), async ([testCase, base]) => {
    const port = await freePortNear(base);
    const problems =
      port === null
        ? [`no free port in [${base}, ${base + CONFIG_PORT_SLOTS})`]
        : judgeStartup(
            contract,
            testCase,
            port,
            await startupOutcome(cmd, dir, configEnv(contract.config, testCase, port), contract.startup.listening),
          );
    return problems.length > 0 ? { name: configCaseName(testCase), problems } : null;
  });
  return { count: cases.length, failures: failures.filter(Boolean) };
}

async function checkService(module, contract, facts) {
  const scratch = mkdtempSync(join(tmpdir(), "contract-"));
  const dir = join(ROOT, module.dir);
  try {
    const cmd = startCommand(module, dir, scratch);
    if (cmd === null) return { module, fatal: "did not build" };
    const failures = [];
    const dockerfile = join(dir, "Dockerfile");
    if (existsSync(dockerfile)) {
      const problems = checkImage(readFileSync(dockerfile, "utf8"), contract.config);
      if (problems.length > 0) failures.push({ name: "image", problems });
    }
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = start(cmd, dir, configEnv(contract.config, null, port));
    try {
      if (!(await waitForReady(base, running, contract.startup.ready, facts))) {
        return {
          module,
          fatal: `did not answer ${contract.startup.ready.path} within ${STARTUP_MS / 1000}s. ${running.output.stderr.trim().slice(-400)}`,
        };
      }
      const exchanges = [];
      failures.push(...(await runCases(base, contract.cases, { exchanges, facts, spec: loadSpec() })));
      failures.push(...(await checkReceiveTimeouts(base, contract.limits.receiveTimeoutsMs)));
      // A log line is written after its response, so give the last ones a moment to arrive.
      const deadline = Date.now() + LOG_WAIT_MS;
      while (Date.now() < deadline && checkLogs(exchanges, running.output.stdout).some((p) => p.includes("logged 0 times"))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const logged = checkLogs(exchanges, running.output.stdout);
      // A service that logs nothing fails every request; the first few say why as well as all of them.
      const shown = logged.length > 5 ? [...logged.slice(0, 5), `and ${logged.length - 5} more`] : logged;
      if (logged.length > 0) failures.push({ name: "request log", problems: shown });
    } finally {
      await stop(running);
    }
    const config = await checkConfig(cmd, dir, contract);
    failures.push(...config.failures);
    if (process.platform === "win32") console.log(`check-contract: ${module.id} shutdown not checked: Windows cannot send it SIGTERM.`);
    else failures.push(...(await checkShutdown(cmd, dir, contract, facts)));
    return { module, failures, configCount: config.count };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Starts `service`, runs `client`'s end-to-end command against it, and returns that command's exit code. */
async function runE2e(client, service, contract, facts) {
  const scratch = mkdtempSync(join(tmpdir(), "contract-"));
  const dir = join(ROOT, service.dir);
  try {
    const cmd = startCommand(service, dir, scratch);
    if (cmd === null) return { fatal: `${service.id} did not build` };
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = start(cmd, dir, configEnv(contract.config, null, port));
    try {
      if (!(await waitForReady(base, running, contract.startup.ready, facts))) {
        return {
          fatal: `${service.id} did not answer ${contract.startup.ready.path} within ${STARTUP_MS / 1000}s. ${running.output.stderr.trim().slice(-400)}`,
        };
      }
      const [command, ...args] = expandCommand(client.e2e.run, { taskApi: base });
      return { code: run(command, args, { cwd: join(ROOT, client.dir) }).status };
    } finally {
      await stop(running);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function e2eMain(args) {
  const present = presentModules();
  const client = present.find((m) => m.id === args[0] && m.e2e);
  if (!client) {
    console.error(
      `check-contract: ${args[0] ?? "(none)"} is not a module present here with an e2e check. Present: ${
        present
          .filter((m) => m.e2e)
          .map((m) => m.id)
          .join(", ") || "none"
      }.`,
    );
    return 2;
  }
  const named = args[1] === "--service" ? args[2] : undefined;
  const service = named === undefined ? e2ePartner(client, present) : present.find((m) => m.id === named && m.taskApi);
  if (!service) {
    console.error(
      `check-contract: ${named ? `${named} is not a task service present here` : "no task service is present"}, so ${client.id} has nothing to run against.`,
    );
    return 2;
  }
  const contract = loadContract();
  const result = await runE2e(client, service, contract, loadFacts(contract));
  if (result.fatal) {
    console.error(`check-contract: ${result.fatal}`);
    return 2;
  }
  if (result.code === 0) console.log(`check-contract: ${client.id} works end to end against ${service.id}.`);
  else console.error(`check-contract: ${client.id} failed end to end against ${service.id} (exit ${result.code}).`);
  return result.code === 0 ? 0 : 1;
}

async function main() {
  if (process.argv[2] === "--e2e") return e2eMain(process.argv.slice(3));
  const requested = process.argv.slice(2);
  const present = presentModules().filter((m) => m.taskApi);
  const unknown = requested.filter((id) => !present.some((m) => m.id === id));
  if (unknown.length > 0) {
    console.error(
      `check-contract: ${unknown.join(", ")} is not a task service present here. Present: ${present.map((m) => m.id).join(", ") || "none"}.`,
    );
    return 2;
  }
  const targets = requested.length > 0 ? present.filter((m) => requested.includes(m.id)) : present;
  if (targets.length === 0) {
    console.log("check-contract: no task service present; nothing to check.");
    return 0;
  }
  const contract = loadContract();
  const facts = loadFacts(contract);
  let code = 0;
  for (const module of targets) {
    const result = await checkService(module, contract, facts);
    if (result.fatal) {
      console.error(`check-contract: ${module.id} ${result.fatal}`);
      code = 2;
      continue;
    }
    const total = `${contract.cases.length} HTTP cases, receive-timeout cases and ${result.configCount} configuration cases`;
    if (result.failures.length > 0) {
      console.error(`check-contract: ${module.id} answered ${result.failures.length} of ${total} differently\n`);
      for (const { name, problems } of result.failures) console.error(`  ${name}: ${problems.join("; ")}`);
      code = Math.max(code, 1);
    } else {
      console.log(`check-contract: ${module.id} matches all ${total}.`);
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
