# mcp-server

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant four tools over the task API: `list_tasks`, `get_task`, `create_task` and `move_task`. It speaks the protocol over stdio, so a client starts it as a subprocess, or over Streamable HTTP, so a client can reach it at a URL ([ADR-0030](../../docs/adr/0030-serve-mcp-over-streamable-http-beside-stdio.md)).

It is the same architecture as the services beside it, with the transport changed ([ADR-0007](../../docs/adr/0007-mcp-server-as-an-adapter.md)): `src/domain` holds the rules, `src/application` the use cases behind an outbound port, `src/adapters` the three things that touch the outside world — the HTTP client that calls the task API, the MCP layer that publishes the use cases as tools, and the HTTP listener that serves the protocol over the network — and `src/main.ts` wires them. `npm run check:boundaries` fails the build when a layer reaches past its allowlist.

The rules are repeated here rather than imported from another module ([ADR-0004](../../docs/adr/0004-independent-modules.md)), and they earn their place: an illegal status move is refused here, with the legal moves named, instead of reaching the model as a 409 it usually retries.

## Run it

```bash
npm ci --ignore-scripts
npm start          # serves over stdio; the task API must be running
```

Register it with a client — for Claude Code, `claude mcp add tasks -- node /absolute/path/to/services/mcp-server/src/main.ts`, or the equivalent entry in another client's configuration:

<!-- generated:fill
```json
{
  "mcpServers": {
    "tasks": {
      "command": "node",
      "args": ["/absolute/path/to/services/mcp-server/src/main.ts"],
      "env": { "TASK_API_URL": "http://localhost:{{contract config.PORT.default.value}}" }
    }
  }
}
```
-->
```json
{
  "mcpServers": {
    "tasks": {
      "command": "node",
      "args": ["/absolute/path/to/services/mcp-server/src/main.ts"],
      "env": { "TASK_API_URL": "http://localhost:8080" }
    }
  }
}
```
<!-- /generated -->

<!-- generated:env-table services/mcp-server/server.json -->
| Variable | Default | Meaning |
|---|---|---|
| `TASK_API_URL` | `http://localhost:8080` | Where the task API is: an absolute http or https URL. |
| `TASK_API_TIMEOUT_MS` | `10000` | How long one call to the task API may take, in milliseconds. |
| `MCP_TRANSPORT` | `stdio` | How the server speaks: stdio, the default, or http. |
| `MCP_HTTP_PORT` | `3000` | The port the http transport listens on; 0 lets the operating system assign one. |
<!-- /generated -->

A value it cannot use stops the process at startup. A server that starts and then fails every tool call is worse than one that never started: the model keeps trying.

### Over HTTP

`MCP_TRANSPORT=http` serves the same tools over Streamable HTTP instead, on port 3000 at `/mcp`:

```bash
MCP_TRANSPORT=http npm start
```

Register the URL with a client — for Claude Code, `claude mcp add --transport http tasks http://localhost:3000/mcp`, or the equivalent entry in another client's configuration:

```json
{
  "mcpServers": {
    "tasks": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

`MCP_HTTP_PORT` picks the port; `0` asks the operating system for one. The endpoint is stateless — every request stands alone, with no session and no authentication — so a deployment that exposes it beyond localhost must front it with a proxy that authenticates.

**Nothing is ever written to stdout, on either transport.** On a stdio server stdout is the protocol channel, and one stray `console.log` corrupts the stream. Diagnostics go to stderr.

## Tools

| Tool | Input | Answers with | Hints |
|---|---|---|---|
| `list_tasks` | — | Every task, its status, and the moves that status allows | read-only |
| `get_task` | `id` | One task, or `NOT_FOUND` naming how to find the id | read-only |
| `create_task` | `title` | The created task, in `todo` | writes, not idempotent |
| `move_task` | `id`, `status` | The moved task, or which moves are legal from where it is | writes, not idempotent |

Every tool declares an output schema, and every successful result carries `structuredContent` beside the text: `{ "tasks": [...] }` or `{ "task": {...} }`, each task with the `nextStatuses` its status allows. A client can parse the value while a model reads the text, and both say the same thing. The hints (`readOnlyHint`, `idempotentHint`, `destructiveHint: false`, `openWorldHint: false`) tell a client which calls it may make without asking.

A failure the caller can act on — a broken rule, an unreachable API — comes back as a tool result with `isError: true` and the reason. Only a bug here throws, because a thrown error reaches the model as a protocol error it cannot inspect.

## Check

<!-- generated:checks services/mcp-server -->
```bash
npm run verify   # lint, check:boundaries, typecheck, test
```
<!-- /generated -->

The tests drive the server through a real MCP client over an in-memory transport pair, so a tool that is registered but unreachable — a bad schema, a handler that throws — fails here rather than in someone's editor.

The tool descriptions state the rules from the domain's own table, which `scripts/check-facts.mjs` holds to `scripts/rules/task-rules.json`, so a model never reads a move the API refuses. `scripts/drive.ts` drives the server over stdio and over HTTP with the SDK's client where the tests cannot reach:

<!-- generated:fill
```bash
npm run e2e -- http://localhost:{{contract config.PORT.default.value}}                        # every tool against a running task API
npm run probe -- 1.2.0 -- docker run --rm -i mcp-server     # the image reports 1.2.0 and speaks the SDK's newest protocol
```
-->
```bash
npm run e2e -- http://localhost:8080                        # every tool against a running task API
npm run probe -- 1.2.0 -- docker run --rm -i mcp-server     # the image reports 1.2.0 and speaks the SDK's newest protocol
```
<!-- /generated -->

`node scripts/verify.mjs` runs the first against a task service of this project whenever one is present, and CI runs the second against the image it builds. The image reports the release it was built as (`--build-arg VERSION=…`, which `mcp-publish.yml` passes); a build without one reports `0.0.0-dev`, so it cannot be taken for a release.

## Publish

`.github/workflows/mcp-publish.yml` publishes the image to GitHub Container Registry and `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io), where clients discover servers. The manifest advertises the stdio form, which any registry client can start; the same image serves HTTP when `MCP_TRANSPORT=http` is set. It uses no stored token: the image is pushed with the run's `GITHUB_TOKEN`, and the registry trusts GitHub's OIDC identity for the `io.github.<owner>/` namespace. The image is built for `linux/amd64` and `linux/arm64`, each on a native runner, and published as one tag, so it runs natively on an Apple Silicon Mac. The two builds also stay in the registry as `<version>-amd64` and `<version>-arm64`. In a private repository the arm64 runner uses paid Actions minutes once the free allowance is spent.

The published image carries a build provenance attestation, a signed record of the workflow run and commit that built it, which anyone can check with `gh attestation verify oci://ghcr.io/<owner>/ultra-template-mcp-server:<version> --owner <owner>`. GitHub provides attestations to public repositories, and to private ones only on GitHub Enterprise Cloud, where setting the repository variable `ATTESTATIONS_ENABLED=true` turns the step on.

It runs after each release that creates a version tag, and on demand with a version. Its first job runs in the GitHub environment `mcp-registry`, which GitHub creates on first use; a required reviewer or a limit on which refs may publish, set there, holds the whole publish. One-time setup:

1. Release at least once, so a `v*` tag exists (the `release` feature does this; `gh release create` works too).
2. Set the repository variable `MCP_PUBLISH_ENABLED=true`, then run the workflow once by hand with that version. **This first run is expected to fail at its last step**, *Publish server.json to the MCP Registry*, with "is private or requires authentication". The images are pushed by then, but GitHub creates a new container package as private, and the registry only accepts an image anyone can pull.
3. Make the package public: on its page, *Package settings* → *Danger Zone* → *Change visibility* → *Public*. It is `OWNER/ultra-template-mcp-server`, listed under the repository's *Packages*. The registry reads the image's `io.modelcontextprotocol.server.name` label to confirm you own it, which it cannot do for a private image. Check before going on: `curl -s -o /dev/null -w '%{http_code}\n' "https://ghcr.io/token?scope=repository:OWNER/ultra-template-mcp-server:pull"` prints `200` once the package is public, and `401` while it is still private.
4. Re-run the failed job of that run (*Re-run failed jobs*). It publishes `server.json`, and every later release publishes on its own.

`test/server-json.test.ts` keeps the manifest honest in the meantime: the image label must equal the server's `name`, and every advertised variable must be one `src/config.ts` reads, with the default it really uses.

## Container

<!-- generated:fill
```bash
docker build --tag mcp-server .
docker run --rm -i --env TASK_API_URL=http://host.docker.internal:{{contract config.PORT.default.value}} mcp-server
docker run --rm --publish 3000:3000 --env TASK_API_URL=http://host.docker.internal:{{contract config.PORT.default.value}} --env MCP_TRANSPORT=http mcp-server
```
-->
```bash
docker build --tag mcp-server .
docker run --rm -i --env TASK_API_URL=http://host.docker.internal:8080 mcp-server
docker run --rm --publish 3000:3000 --env TASK_API_URL=http://host.docker.internal:8080 --env MCP_TRANSPORT=http mcp-server
```
<!-- /generated -->

`-i` matters on the first form: the protocol is stdin and stdout. The second form serves it over HTTP instead, on the port the image exposes.
