// The contract check must be seen to fail. A runner that only ever meets services that comply
// proves nothing: it passes just as well when it compares nothing.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  checkConfig,
  checkImage,
  checkLogs,
  checkShutdown,
  shutdownCases,
  checkSpec,
  codePointsWith,
  conforms,
  configCases,
  configEnv,
  encodeBody,
  expectedReport,
  fillPort,
  judge,
  judgeStartup,
  loadCases,
  loadContract,
  loadFacts,
  loadSpec,
  operationFor,
  requestIdPattern,
  resolveRef,
  runCases,
} from "../scripts/check-contract.mjs";
import { loadRules } from "../scripts/rules/load.mjs";

const CONTRACT = loadContract();
const FACTS = loadFacts(CONTRACT);
// The moves the fake service allows unless `mistakes.moves` says otherwise: the rules' own.
const MOVES = loadRules().transitions;
const REQUEST_ID = requestIdPattern(CONTRACT.limits);

/** A minimal task service that is right about everything except what `mistakes` says. */
function fakeService(t, mistakes = {}) {
  const tasks = new Map();
  let generated = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const sent = req.headers["x-request-id"];
      const id = mistakes.alwaysGenerate || typeof sent !== "string" || !REQUEST_ID.test(sent) ? `gen-${++generated}` : sent;
      const send = (status, body, allow) => {
        const headers = { "content-type": mistakes.textErrors && status >= 400 ? "text/plain" : "application/json" };
        if (allow && !mistakes.noAllow) headers.allow = allow;
        if (!mistakes.noRequestId) headers["x-request-id"] = id;
        res.writeHead(status, headers);
        res.end(mistakes.textErrors && status >= 400 ? "nope" : JSON.stringify(body));
      };
      if (req.url === "/healthz") return send(200, { status: "ok" });
      if (req.url === "/api/tasks" && req.method === "GET") return send(200, mistakes.newestFirst ? [...tasks.values()].reverse() : [...tasks.values()]);
      if (req.url === "/api/tasks" && req.method === "DELETE") return send(405, { error: "method not allowed" }, "GET, HEAD, POST");
      if (req.url === "/api/tasks" && req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        if ((body.title ?? "").trim() === "") return send(mistakes.emptyTitle ?? 422, { error: "title must not be empty" });
        const at = mistakes.badTimestamp ? "x" : "2026-01-02T03:04:05.678Z";
        const task = { id: `t${tasks.size + 1}`, title: body.title.trim(), status: "todo", createdAt: at, updatedAt: at };
        tasks.set(task.id, task);
        return send(201, task);
      }
      const match = /^\/api\/tasks\/([^/]+)$/.exec(req.url ?? "");
      if (match && req.method === "GET") return tasks.has(match[1]) ? send(200, tasks.get(match[1])) : send(404, { error: "task not found" });
      const move = /^\/api\/tasks\/([^/]+)\/status$/.exec(req.url ?? "");
      if (move && req.method === "PATCH") {
        const task = tasks.get(move[1]);
        if (!task) return send(404, { error: "task not found" });
        // A read, a pause, and a write from what was read: two moves in the pause both succeed.
        if (mistakes.racyMoves) await new Promise((resolve) => setTimeout(resolve, 20));
        const next = JSON.parse(raw || "{}").status;
        if (!(mistakes.moves ?? MOVES)[task.status].includes(next)) return send(409, { error: "status transition not allowed" });
        tasks.set(task.id, { ...task, status: next });
        return send(200, tasks.get(task.id));
      }
      return send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    t.after(() => server.close());
  });
}

const CASES = [
  { name: "health", method: "GET", path: "/healthz", status: 200, json: { status: "ok" } },
  { name: "create", method: "POST", path: "/api/tasks", body: '{"title":" a "}', status: 201, task: { title: "a", status: "todo" } },
  { name: "empty title", method: "POST", path: "/api/tasks", body: '{"title":" "}', status: 422, error: true },
  { name: "get", method: "GET", path: "/api/tasks/{id}", status: 200, task: { status: "todo" } },
  { name: "unknown", method: "GET", path: "/nope", status: 404, error: true },
];

test("a service that keeps the contract passes", async (t) => {
  assert.deepEqual(await runCases(await fakeService(t), CASES), []);
});

test("a wrong status fails, and names the case", async (t) => {
  const failures = await runCases(await fakeService(t, { emptyTitle: 400 }), CASES);
  assert.deepEqual(failures.map((f) => f.name), ["empty title"]);
  assert.match(failures[0].problems.join(), /status 400, expected 422/);
});

test("the right status with an error that is not JSON still fails", async (t) => {
  const failures = await runCases(await fakeService(t, { textErrors: true }), CASES);
  assert.deepEqual(failures.map((f) => f.name), ["empty title", "unknown"]);
  assert.match(failures[1].problems.join(), /no \{"error"|content-type text\/plain/);
});

const moveTo = (status) => ({ method: "PATCH", path: "/api/tasks/{id}/status", body: JSON.stringify({ status }), status: 200 });

test("every answer carries a request id, and a usable one sent is echoed while an unsafe one is replaced", async (t) => {
  const cases = [
    { name: "health", method: "GET", path: "/healthz", status: 200 },
    { name: "echo", method: "GET", path: "/healthz", headers: { "X-Request-Id": "contract.echo-1" }, requestId: "echo", status: 200 },
    { name: "replace", method: "GET", path: "/healthz", headers: { "X-Request-Id": "has space" }, requestId: "replaced", status: 200 },
  ];
  assert.deepEqual(await runCases(await fakeService(t), cases), []);

  const missing = await runCases(await fakeService(t, { noRequestId: true }), cases);
  assert.deepEqual(missing.map((f) => f.name), ["health", "echo", "replace"]);
  assert.match(missing[0].problems.join(), /no usable X-Request-Id header/);

  const ignored = await runCases(await fakeService(t, { alwaysGenerate: true }), cases);
  assert.deepEqual(ignored.map((f) => f.name), ["echo"]);
  assert.match(ignored[0].problems.join(), /X-Request-Id "gen-2", expected the "contract.echo-1" that was sent/);

  // A case the language's own server may answer before the service sees it needs no id.
  const early = [{ name: "early", method: "GET", path: "/healthz", status: 200, beforeService: true }];
  assert.deepEqual(await runCases(await fakeService(t, { noRequestId: true }), early), []);
});

test("every request with an id is logged once, as it was answered", () => {
  const exchanges = [
    { requestId: "a", method: "GET", path: "/healthz", status: 200 },
    { requestId: "b", method: "PATCH", path: "/api/tasks/t1/status", status: 409 },
  ];
  const line = (entry) => JSON.stringify({ time: "2026-01-02T03:04:05Z", level: "info", msg: "request", durationMs: 0.4, ...entry });
  const good = [
    '{"level":"info","msg":"listening"}',
    line({ method: "GET", path: "/healthz", status: 200, requestId: "a" }),
    line({ method: "PATCH", path: "/api/tasks/t1/status", status: 409, requestId: "b" }),
  ];
  assert.deepEqual(checkLogs(exchanges, good.join("\n")), []);

  assert.match(checkLogs(exchanges, good.slice(0, 2).join("\n")).join(), /request b \(PATCH \/api\/tasks\/t1\/status\) was logged 0 times, expected once/);
  assert.match(checkLogs(exchanges, [...good, good[1]].join("\n")).join(), /request a \(GET \/healthz\) was logged 2 times/);
  const wrong = [good[0], line({ method: "GET", path: "/healthz", status: 500, requestId: "a", durationMs: -1, level: "INFO" }), good[2]];
  assert.match(checkLogs(exchanges, wrong.join("\n")).join(), /request a logged status 500, expected 200.*durationMs -1.*level "INFO"/);
  assert.match(checkLogs(exchanges, [...good, "listening on 8080"].join("\n")).join(), /stdout line is not JSON: listening on 8080/);
  assert.match(checkLogs([...exchanges, { ...exchanges[0], path: "/api/tasks" }], good.join("\n")).join(), /request id a was given to 2 responses/);
});

test("setup steps stage the task a case is sent to", async (t) => {
  const cases = [
    { name: "done from in progress", ...moveTo("done"), setup: [moveTo("in_progress")], task: { status: "done" } },
    { name: "nothing leaves done", ...moveTo("todo"), status: 409, error: true, setup: [moveTo("in_progress"), moveTo("done")] },
  ];
  assert.deepEqual(await runCases(await fakeService(t), cases), []);
});

test("a setup step that does not land is reported as itself, and its case is not sent", async (t) => {
  // This service cannot start a task, so no case staged from in_progress can be judged.
  const stuck = { todo: [], in_progress: ["todo", "done"], done: [] };
  const cases = [{ name: "done from in progress", ...moveTo("done"), setup: [moveTo("in_progress")], task: { status: "done" } }];
  const failures = await runCases(await fakeService(t, { moves: stuck }), cases);
  assert.deepEqual(failures.map((f) => f.name), ["done from in progress"]);
  assert.deepEqual(failures[0].problems, ["setup 1 (PATCH /api/tasks/t1/status) answered 409, expected 200"]);
});

test("the contract states every pair of statuses, legal or not, as the rules do", () => {
  const { statuses, transitions } = loadRules();
  const moves = new Map();
  for (const c of loadCases()) {
    if (c.method !== "PATCH" || c.path !== "/api/tasks/{id}/status" || typeof c.body !== "string") continue;
    // Some bodies are malformed on purpose, or padded to a size; they state no move.
    if ("padTo" in c) continue;
    let body = null;
    try {
      body = JSON.parse(c.body || "null");
    } catch {}
    if (body === null || Object.keys(body).join() !== "status" || !statuses.includes(body.status)) continue;
    const staged = (c.setup ?? []).filter((step) => step.path === c.path).map((step) => JSON.parse(step.body).status);
    moves.set(`${staged.at(-1) ?? statuses[0]} → ${body.status}`, c.status);
  }
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = transitions[from].includes(to) ? 200 : 409;
      assert.equal(moves.get(`${from} → ${to}`), expected, `the move ${from} → ${to} should be a case answered ${expected}`);
    }
  }
});

test("a task the contract creates starts in the first status the rules list", () => {
  const created = CONTRACT.cases.filter((c) => c.method === "POST" && c.path === "/api/tasks" && c.task);
  assert.ok(created.length > 0);
  for (const c of created) assert.equal(c.task.status, loadRules().statuses[0], c.name);
});

test("judge checks the task's fields and values, not only the status", () => {
  const answer = (body) => ({ status: 201, type: "application/json", requestId: "r1", text: JSON.stringify(body) });
  const wanted = { status: 201, task: { status: "todo" } };
  assert.deepEqual(judge(wanted, answer({ id: "1", title: "a", status: "todo", createdAt: "x", updatedAt: "x" }), FACTS), []);
  assert.match(judge(wanted, answer({ id: "1", title: "a", status: "todo" }), FACTS).join(), /task fields/);
  assert.match(judge(wanted, answer({ id: "1", title: "a", status: "done", createdAt: "x", updatedAt: "x" }), FACTS).join(), /status "done"/);
});

test("the committed cases are well formed and each name is unique", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 30, `${cases.length} cases`);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
  for (const c of cases) {
    assert.match(c.method, /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/, c.name);
    assert.ok(c.path.startsWith("/"), c.name);
    assert.ok(Number.isInteger(c.status), c.name);
    for (const step of c.setup ?? []) {
      assert.match(step.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${c.name}: setup`);
      assert.ok(step.path.startsWith("/"), `${c.name}: setup`);
      assert.ok(Number.isInteger(step.status), `${c.name}: setup`);
    }
  }
  // Large bodies are described, not stored: the file stays small and reviewable.
  const facts = { rules: { maxTitleLength: 3 }, limits: { maxBodyBytes: 20 } };
  assert.equal(JSON.parse(encodeBody({ title: { repeat: "ab", times: { ref: "rules.maxTitleLength" } } }, facts)).title, "ababab");
  assert.equal(encodeBody('{"a":1}', facts, { ref: "limits.maxBodyBytes" }), `{"a":1}${" ".repeat(13)}`);
  assert.throws(() => encodeBody("x".repeat(30), facts, { ref: "limits.maxBodyBytes" }), /already 30 bytes, more than the 20/);
});

/** Every count the contract states, as [where, value]: a `times` inside a body or a header, and a `padTo`. */
function counts(cases) {
  const found = [];
  const visit = (where, value) => {
    if (value === null || typeof value !== "object") return;
    if ("repeat" in value) found.push([`${where} times`, value.times]);
    else for (const [key, inner] of Object.entries(value)) visit(`${where}.${key}`, inner);
  };
  for (const c of cases) {
    visit(`"${c.name}" body`, c.body);
    visit(`"${c.name}" headers`, c.headers);
    if ("padTo" in c) found.push([`"${c.name}" padTo`, c.padTo]);
  }
  return found;
}

test("every count in the contract refers to the limit or rule it tests, and no case name restates one", () => {
  const found = counts(CONTRACT.cases);
  assert.ok(found.length >= 6, `${found.length} counts`);
  for (const [where, value] of found) {
    assert.ok(value !== null && typeof value === "object" && typeof value.ref === "string", `${where} is ${JSON.stringify(value)}, not a { "ref": … }`);
    assert.equal(typeof resolveRef(value, FACTS), "number", where);
  }
  for (const c of CONTRACT.cases) assert.doesNotMatch(c.name, /\d/, `the case name "${c.name}" states a number`);
  // Each bound is tested at its value and one past it.
  const refs = found.map(([, value]) => `${value.ref}${value.plus ? `+${value.plus}` : ""}`);
  for (const bound of ["limits.maxBodyBytes", "limits.requestId.maxLength", "rules.maxTitleLength"]) {
    assert.ok(refs.includes(bound) && refs.includes(`${bound}+1`), `${bound} is not tested at its value and one past it`);
  }
});

test("a count written as a number, or referring to nothing, is refused", () => {
  assert.throws(() => resolveRef(201, FACTS), /a count must be \{ "ref": … \}, not 201/);
  assert.throws(() => resolveRef({ ref: "limits.maxBodyMegabytes" }, FACTS), /limits\.maxBodyMegabytes names no number/);
  assert.equal(resolveRef({ ref: "rules.maxTitleLength", plus: 1 }, FACTS), loadRules().maxTitleLength + 1);
  assert.throws(() => encodeBody({ title: { repeat: "a", times: 3 } }, FACTS), /a count must be/);
});

test("the request id pattern comes from the limits", () => {
  const pattern = requestIdPattern({ requestId: { characters: "a-z", maxLength: 3 } });
  assert.ok(pattern.test("abc") && !pattern.test("abcd") && !pattern.test("ab1") && !pattern.test(""));
});

test("the OpenAPI document agrees with the contract cases and the task rules", () => {
  assert.deepEqual(checkSpec(loadSpec(), CONTRACT, loadRules()), []);
});

test("every way the OpenAPI document can disagree is reported", () => {
  const spec = () => structuredClone(loadSpec());
  const cases = CONTRACT;
  const rules = loadRules();

  // A case answered with a status the document does not list.
  const unlisted = spec();
  delete unlisted.paths["/api/tasks/{id}/status"].patch.responses["409"];
  assert.match(checkSpec(unlisted, cases, rules).join("\n"), /case "move refuses a skipped step": PATCH \/api\/tasks\/\{id\}\/status answers 409, which the document does not list/);

  // A response no case exercises.
  const unexercised = spec();
  unexercised.paths["/api/tasks"].get.responses["500"] = { description: "never happens" };
  assert.match(checkSpec(unexercised, cases, rules).join("\n"), /lists 500 for GET \/api\/tasks, which no case exercises/);

  // A method a path does not list must be answered 405.
  const extra = { ...CONTRACT, cases: [...CONTRACT.cases, { name: "delete a task", method: "DELETE", path: "/api/tasks/{id}", status: 204 }] };
  assert.match(checkSpec(spec(), extra, rules).join("\n"), /case "delete a task" sends DELETE to \/api\/tasks\/\{id\}, which the document does not list, and expects 204 rather than 405/);

  // The task's fields are the ones every service answers with.
  const fields = spec();
  fields.components.schemas.Task.properties.priority = { type: "integer" };
  assert.match(checkSpec(fields, cases, rules).join("\n"), /Task schema has fields createdAt,id,priority,status,title,updatedAt, expected createdAt,id,status,title,updatedAt/);

  // The statuses and the title length are the rules'.
  const statuses = spec();
  statuses.components.schemas.Status.enum = ["todo", "done"];
  assert.match(checkSpec(statuses, cases, rules).join("\n"), /Status enum is \["todo","done"\], expected \["todo","in_progress","done"\]/);
  const title = spec();
  title.components.schemas.CreateTask.properties.title.maxLength = 100;
  assert.match(checkSpec(title, cases, rules).join("\n"), new RegExp(`CreateTask title maxLength is 100, expected ${rules.maxTitleLength}`));

  // The request id pattern and the body limit are the contract's.
  const id = spec();
  id.components.headers.RequestId.schema.pattern = "^[A-Za-z0-9]{1,64}$";
  assert.match(checkSpec(id, cases, rules).join("\n"), /RequestId header pattern is \^\[A-Za-z0-9\]\{1,64\}\$, expected/);
  const body = spec();
  body.components.responses.BadRequest["x-maxBodyBytes"] = 1;
  assert.match(checkSpec(body, cases, rules).join("\n"), new RegExp(`x-maxBodyBytes is 1, expected ${CONTRACT.limits.maxBodyBytes}`));
});

test("the configuration section is well formed, and every placeholder is one the runner fills", () => {
  const variables = Object.entries(CONTRACT.config).filter(([name]) => !name.startsWith("$"));
  assert.ok(variables.length > 0);
  const reported = new Set();
  for (const [name, spec] of variables) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, name);
    assert.equal(typeof spec.reportedAs, "string", name);
    assert.ok(!reported.has(spec.reportedAs), `${name} reports as ${spec.reportedAs}, as another variable does`);
    reported.add(spec.reportedAs);
    assert.equal(typeof spec.default.value, "string", `${name} default value`);
    assert.equal(typeof spec.default.effective, "number", `${name} default effective`);
    for (const { value, effective } of spec.accept) {
      assert.equal(typeof value, "string", `${name} accept`);
      assert.ok(typeof effective === "number" || effective === "{port}", `${name}=${value} effective`);
      assert.doesNotThrow(() => fillPort(value, 1), `${name}=${value}`);
    }
    for (const value of spec.refuse) assert.doesNotThrow(() => fillPort(value, 1), `${name}=${value}`);
    const values = [...spec.accept.map((a) => a.value), ...spec.refuse];
    assert.equal(new Set(values).size, values.length, `${name} lists a value twice`);
  }
  assert.throws(() => fillPort("{port:roman}", 1), /unknown digits \{port:roman\}/);
  assert.equal(fillPort("{port:fullwidth}|{port:arabic-indic}|+{port}", 809), "\uff18\uff10\uff19|\u0668\u0660\u0669|+809");
});

test("configuration cases: an unset and an empty variable read as its default, except where that would bind a port", () => {
  const config = {
    PORT: { reportedAs: "port", binds: true, default: { value: "80", effective: 80 }, accept: [{ value: "{port}", effective: "{port}" }], refuse: ["x"] },
    WAIT: { reportedAs: "waitMs", default: { value: "1s", effective: 1000 }, accept: [{ value: "2s", effective: 2000 }], refuse: ["-1s"] },
  };
  const cases = configCases(config);
  assert.deepEqual(cases.map((c) => [c.variable, c.value, c.accept]), [
    ["PORT", "{port}", true],
    ["PORT", "x", false],
    ["WAIT", undefined, true],
    ["WAIT", "", true],
    ["WAIT", "1s", true],
    ["WAIT", "2s", true],
    ["WAIT", "-1s", false],
  ]);
  // A value in the shell that runs the check never leaks in.
  const env = configEnv(config, cases[5], 4321, { PATH: "/bin", WAIT: "9s", PORT: "1" });
  assert.deepEqual(env, { PATH: "/bin", PORT: "4321", WAIT: "2s" });
  assert.deepEqual(configEnv(config, cases[2], 4321, { WAIT: "9s" }), { PORT: "4321" });
  assert.deepEqual(configEnv(config, null, 4321, { WAIT: "9s" }), { PORT: "4321" });
  assert.deepEqual(expectedReport(config, cases[5], 4321), { port: 4321, waitMs: 2000 });
  assert.deepEqual(expectedReport(config, cases[0], 4321), { port: 4321, waitMs: 1000 });
});

test("a start is judged on its listening line, or on its refusal line and exit code", () => {
  const contract = { config: { WAIT: { reportedAs: "waitMs", default: { value: "1s", effective: 1000 }, accept: [], refuse: [] } }, startup: CONTRACT.startup };
  const { listening, refused } = CONTRACT.startup;
  const up = (fields) => ({ lines: [{ ...listening, ...fields }], listening: { ...listening, ...fields }, exitCode: null, stderr: "" });
  const down = (lines, exitCode = refused.exitCode) => ({ lines, listening: null, exitCode, stderr: "" });
  const take = { variable: "WAIT", value: "0.25ms", accept: true, effective: 0.25 };
  const refuse = { variable: "WAIT", value: "x", accept: false };
  const refusal = { level: refused.level, msg: refused.msg, error: "WAIT must be a duration" };

  assert.deepEqual(judgeStartup(contract, take, 1, up({ waitMs: 0.25000000000000006 })), [], "floating point is not a mismatch");
  assert.match(judgeStartup(contract, take, 1, up({ waitMs: 250 })).join(), /reports waitMs 250, expected 0\.25/);
  assert.match(judgeStartup(contract, take, 1, down([refusal])).join(), /exited 2 instead of starting: WAIT must be a duration/);
  assert.deepEqual(judgeStartup(contract, refuse, 1, down([refusal])), []);
  assert.match(judgeStartup(contract, refuse, 1, up({ waitMs: 1000 })).join(), /started, reporting .* where it must refuse the value/);
  assert.match(judgeStartup(contract, refuse, 1, down([refusal], 1)).join(), new RegExp(`exited 1, expected ${refused.exitCode}`));
  assert.match(judgeStartup(contract, refuse, 1, down([])).join(), /wrote no .*invalid configuration.* line to stdout/);
  assert.match(judgeStartup(contract, refuse, 1, down([{ ...refusal, error: "bad value" }])).join(), /its error "bad value" does not name WAIT/);
});

test("an image exposes the port the contract defaults to, and sets no contract variable", () => {
  const { config } = CONTRACT;
  const port = config.PORT.default.value;
  assert.deepEqual(checkImage(`FROM x\nEXPOSE ${port}\nCMD ["x"]\n`, config), []);
  assert.deepEqual(checkImage(`FROM x\nEXPOSE ${port}/tcp\n`, config), []);
  assert.match(checkImage("FROM x\nEXPOSE 9999\n", config).join(), new RegExp(`exposes 9999, but PORT defaults to ${port}`));
  assert.match(checkImage("FROM x\n", config).join(), /exposes no port/);
  assert.match(checkImage(`FROM x\nENV A=1 \\\n    PORT=9999\nEXPOSE ${port}\n`, config).join(), /sets PORT, so the image's default is not the contract's/);
});

// A service whose configuration parser has the mistakes api-py once had: any script's digits, and a
// final newline, read as a number. The runner must start it for each value and catch both.
const LENIENT_SERVICE = `
const env = process.env;
const log = (line) => console.log(JSON.stringify({ time: new Date().toISOString(), ...line }));
const port = /^\\p{Nd}+\\n?$/u.test(env.PORT ?? "") ? Number([...env.PORT.trim()].map((c) => /\\p{Nd}/u.test(c) ? String(c.codePointAt(0) & 15) : c).join("")) : NaN;
if (!(port >= 1 && port <= 65535)) { log({ level: "error", msg: "invalid configuration", error: "PORT must be a port" }); process.exit(2); }
const server = require("node:http").createServer((req, res) => res.end());
server.listen(port, "127.0.0.1", () => log({ level: "info", msg: "listening", port }));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

test("the configuration runner starts a real process for each value and catches a lenient parser", async () => {
  const contract = {
    startup: CONTRACT.startup,
    config: {
      PORT: {
        reportedAs: "port",
        binds: true,
        default: { value: "8080", effective: 8080 },
        accept: [{ value: "{port}", effective: "{port}" }],
        refuse: ["http", "{port:fullwidth}", "{port}\n"],
      },
    },
  };
  const { count, failures } = await checkConfig([process.execPath, "-e", LENIENT_SERVICE], process.cwd(), contract);
  assert.equal(count, 4);
  assert.deepEqual(failures.map((f) => f.name), ['PORT="{port:fullwidth}"', 'PORT="{port}\\n"']);
  assert.match(failures[0].problems.join(), /started, reporting .*"msg":"listening".* where it must refuse the value/);
});


// The answers are held to the OpenAPI document as well as to the cases.
const SPEC = loadSpec();

test("a value is held to its schema: type, enum, pattern, lengths in code points, date-time, fields and items", () => {
  const spec = { components: { schemas: { S: { type: "string", enum: ["a", "b"] } } } };
  const schema = {
    type: "object",
    required: ["id", "at"],
    properties: { id: { type: "string", pattern: "^t[0-9]+$", maxLength: 3 }, at: { type: "string", format: "date-time" }, s: { $ref: "#/components/schemas/S" }, n: { type: ["string", "null"] }, list: { type: "array", items: { type: "integer" } } },
    additionalProperties: false,
  };
  assert.deepEqual(conforms(spec, schema, { id: "t1", at: "2026-01-02T03:04:05.678Z", s: "a", n: null, list: [1, 2] }), []);
  const found = conforms(spec, schema, { id: "t1234", at: "x", s: "c", n: 1, list: [1, "2"], extra: true });
  for (const problem of [/\$\.id is 5 characters, more than 3/, /\$\.at is not a date-time/, /\$\.s is "c", not one of \["a","b"\]/, /\$\.n is a number, not string or null/, /\$\.list\[1\] is a string, not integer/, /\$ has extra, which the schema does not allow/]) {
    assert.match(found.join("\n"), problem);
  }
  assert.match(conforms(spec, schema, { id: "x" }).join("\n"), /\$ has no at, which is required/);
  assert.match(conforms(spec, schema, { id: "x1" }).join("\n"), /\$\.id "x1" does not match \^t\[0-9\]\+\$/);
  assert.deepEqual(conforms(spec, { type: "string", maxLength: 2 }, "🙂🙂"), [], "two code points, four UTF-16 units");
});

test("an operation is found by its path template, and a method it does not list is named with the ones it does", () => {
  assert.equal(operationFor(SPEC, "GET", "/api/tasks/t1?x=1").template, "/api/tasks/{id}");
  assert.deepEqual(operationFor(SPEC, "DELETE", "/api/tasks").allow, ["GET", "HEAD", "POST"]);
  assert.equal(operationFor(SPEC, "DELETE", "/api/tasks").operation, undefined);
  assert.equal(operationFor(SPEC, "GET", "/nope"), undefined);
});

test("an answer that breaks the document's schema fails, list items included", async (t) => {
  const cases = [...CASES, { name: "list", method: "GET", path: "/api/tasks", status: 200, array: true }];
  assert.deepEqual(await runCases(await fakeService(t), cases, { spec: SPEC }), []);
  const failures = await runCases(await fakeService(t, { badTimestamp: true }), cases, { spec: SPEC });
  assert.deepEqual(failures.map((f) => f.name), ["create", "get", "list"]);
  assert.match(failures[0].problems.join(), /\$\.createdAt is not a date-time/);
  assert.match(failures[2].problems.join(), /\$\[0\]\.createdAt is not a date-time/);
});

test("a list shows the tasks in the order they were created", async (t) => {
  const cases = [{ name: "oldest first", method: "GET", path: "/api/tasks", status: 200, array: true, oldestFirst: true }];
  assert.deepEqual(await runCases(await fakeService(t), cases), []);
  const failures = await runCases(await fakeService(t, { newestFirst: true }), cases);
  assert.match(failures[0]?.problems.join() ?? "", /lists the tasks it created as t3, t2, t1, not in the order they were created \(t1, t2, t3\)/);
});

test("a 405 names the methods the document lists for the path, with HEAD beside GET", async (t) => {
  const cases = [{ name: "list refuses DELETE", method: "DELETE", path: "/api/tasks", status: 405, error: true }];
  assert.deepEqual(await runCases(await fakeService(t), cases, { spec: SPEC }), []);
  const failures = await runCases(await fakeService(t, { noAllow: true }), cases, { spec: SPEC });
  assert.match(failures[0]?.problems.join() ?? "", /Allow "", expected "GET, HEAD, POST"/);
});

test("a body given as bytes is sent as exactly those bytes", async (t) => {
  let received;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = Buffer.concat(chunks);
      res.writeHead(400, { "content-type": "application/json", "x-request-id": "r1" });
      res.end('{"error":"x"}');
    });
  });
  const base = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => server.close());
  const cases = [{ name: "bom", method: "POST", path: "/api/tasks", bodyHex: "efbbbf7b7d", status: 400, error: true }];
  assert.deepEqual(await runCases(base, cases), []);
  assert.equal(received.toString("hex"), "efbbbf7b7d");
});

test("of the same request sent at once, exactly one gets the status and the rest the other", async (t) => {
  const cases = [
    {
      name: "one of the moves to done wins",
      method: "PATCH",
      path: "/api/tasks/{id}/status",
      setup: [moveTo("in_progress")],
      body: '{"status":"done"}',
      concurrent: 16,
      status: 200,
      othersStatus: 409,
      task: { status: "done" },
    },
  ];
  assert.deepEqual(await runCases(await fakeService(t), cases), []);
  const failures = await runCases(await fakeService(t, { racyMoves: true }), cases);
  assert.match(failures[0]?.problems.join() ?? "", /16 of 16 concurrent requests answered 200, expected exactly 1/);
});

test("a title built from the rules' whitespace property holds every character with it, and nothing else", () => {
  const all = codePointsWith(FACTS.rules.titleWhitespace);
  assert.equal([...all].length, 25, "Unicode's White_Space property");
  for (const kept of ["\u001f", "\ufeff", "\u200b", "a"]) assert.equal(all.includes(kept), false, JSON.stringify(kept));
  for (const trimmed of ["\u0085", "\u00a0", "\u3000", "\u2028"]) assert.equal(all.includes(trimmed), true, JSON.stringify(trimmed));
  const body = JSON.parse(encodeBody({ title: { whitespace: "rules.titleWhitespace", around: "a" } }, FACTS));
  assert.equal(body.title, `${all}a${all}`);
  assert.throws(() => encodeBody({ title: { whitespace: "rules.nothing" } }, FACTS), /rules\.nothing names no Unicode property/);
});

// A service that shuts down as the contract says, unless FAKE_MISTAKE names what it gets wrong.
const SHUTTING_DOWN_SERVICE = `
const http = require("node:http");
const units = { h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
const raw = process.env.SHUTDOWN_TIMEOUT || "10s";
const [, n, unit] = /^([0-9.]+)([a-z]+)$/.exec(raw);
const timeout = Number(n) * units[unit];
const mistake = process.env.FAKE_MISTAKE;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(req.url === "/healthz" ? 200 : 201, { "content-type": "application/json" });
    res.end("{}");
  });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  if (mistake === "exitAtOnce") process.exit(0);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  if (mistake !== "waitForever") setTimeout(() => process.exit(1), Math.min(timeout, 2 ** 31 - 1));
});
`;

test("the shutdown cases are the timeout's default, its longest accepted value and its shortest", () => {
  const cases = shutdownCases(CONTRACT);
  assert.deepEqual(
    cases.map((c) => [c.value, c.finishes]),
    [
      [undefined, true],
      ["2562047h", true],
      ["400ns", false],
    ],
  );
});

test("a service must finish a request in flight after SIGTERM, and give up on it once the timeout passes", { skip: process.platform === "win32" && "SIGTERM cannot be sent on Windows" }, async () => {
  const run = (mistake) => checkShutdown([process.execPath, "-e", SHUTTING_DOWN_SERVICE], process.cwd(), CONTRACT, FACTS, { ...process.env, FAKE_MISTAKE: mistake ?? "" });
  assert.deepEqual(await run(), []);
  const early = await run("exitAtOnce");
  assert.deepEqual(early.map((f) => f.name), ["shutdown with SHUTDOWN_TIMEOUT unset", 'shutdown with SHUTDOWN_TIMEOUT="2562047h"', 'shutdown with SHUTDOWN_TIMEOUT="400ns"']);
  assert.match(early[0].problems.join(), /exited 0 with a request in flight/);
  assert.match(early[2].problems.join(), /exited 0 after giving up on a request in flight, expected 1/);
  const stuck = await run("waitForever");
  assert.deepEqual(stuck.map((f) => f.name), ['shutdown with SHUTDOWN_TIMEOUT="400ns"']);
  assert.match(stuck[0].problems.join(), /still running .* after SIGTERM, with a request it could not finish/);
});
