---
name: change-task-contract
description: Change a task rule (a status, a legal move, the longest title, the whitespace a title is trimmed of), a limit, a configuration variable or a route of the task API in every module at once. Use when a task changes what the task services accept or answer, or what the modules that repeat the rules hold of them.
---

# Change the task contract

Every fact below is stated once and held everywhere else by a check, so the order is: the statement
first, then the check that fails, then each module until it passes. Never change one module alone.

1. **State the change once.**
   - A status, a legal move, the longest title or the whitespace a title is trimmed of: `scripts/rules/task-rules.json`.
<!-- ultra:begin go-service|ts-service|py-service|mcp-server|web -->
   - A limit (body size, request id), a configuration variable (its default, the values it must take or
     refuse), the startup and refusal lines, a route or a status code: `scripts/contract/tasks-api.json`.
     A case refers to a limit or rule as `{ "ref": "limits.maxBodyBytes", "plus": 1 }`; never write the
     number. Test a bound at its value and one past it.
   - A route, a field or a status code also goes in `scripts/contract/openapi.json`, which is held to the
     cases in both directions.
<!-- ultra:end go-service|ts-service|py-service|mcp-server|web -->
2. **See it fail.** That is the change reproduced.
<!-- ultra:begin go-service|ts-service|py-service -->
   - `node scripts/check-contract.mjs` shows each task service answering the old way.
<!-- ultra:end go-service|ts-service|py-service -->
<!-- ultra:begin mcp-server|web|ts-library -->
   - `node scripts/check-facts.mjs` shows each module that repeats a fact still holding the old one.
<!-- ultra:end mcp-server|web|ts-library -->
3. **Change each module, each with its own tests.** Build a message that states a limit from the constant
   that holds it, never from a copy of the number.
<!-- ultra:begin go-service -->
   - The Go service, following the `add-endpoint-go` skill.
<!-- ultra:end go-service -->
<!-- ultra:begin ts-service -->
   - The TypeScript service, following the `add-endpoint-ts` skill.
<!-- ultra:end ts-service -->
<!-- ultra:begin py-service -->
   - The Python service, following the `add-endpoint-py` skill.
<!-- ultra:end py-service -->
<!-- ultra:begin mcp-server -->
   - The MCP server: its domain and its configuration. Its tool descriptions are built from the domain, so
     they follow; change its `server.json` if a variable it advertises changed.
<!-- ultra:end mcp-server -->
<!-- ultra:begin web -->
   - The web app: its task model, and the port its dev server proxies to.
<!-- ultra:end web -->
<!-- ultra:begin ts-library -->
   - The library: the rules it exports.
<!-- ultra:end ts-library -->
4. **Prose.** A README that names what changed; `node scripts/verify.mjs` fails on a generated block that
   is stale, so fix the text around it.
5. **Verify.** `node scripts/verify.mjs` runs every check above, and any end-to-end check a module declares.
   Say what ran, as `AGENTS.md` asks.
