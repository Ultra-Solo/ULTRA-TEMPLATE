# ADR-0007: Expose the domain to assistants through an MCP adapter, not a second service

**Status:** Accepted · Amended by [ADR-0010](0010-one-statement-of-the-task-rules.md) · **Date:** 2026-09-17

## Context

Projects increasingly need to be usable by an AI assistant as well as by a person and a browser. The Model Context Protocol is the interface for that: a server declares tools with input schemas, a client discovers them, and a model calls them.

Where that server belongs is a structural decision. The obvious placements are wrong in different ways. Adding MCP handling inside an existing HTTP service gives one deployable two protocols and two failure modes, and an MCP server is usually started as a subprocess by the client, which is not how an HTTP service runs. Writing a standalone server that reimplements the rules produces a second definition of what a legal status move is, which diverges the first time either side changes.

There is also a protocol-shaped trap. An MCP tool has two distinct ways to fail: a thrown error, which reaches the client as a protocol error the model cannot inspect, and a result with `isError: true`, which the model reads and can act on. Which failures go where is a decision, not a detail — refusing a call by throwing makes a model retry the same call.

## Decision

- The MCP server is its own module, `services/mcp-server`, with the same layers as the services: a pure `src/domain`, use cases in `src/application` behind an outbound `TaskGateway` port, `src/adapters` holding the HTTP client that calls the task API and the MCP registration that publishes the use cases as tools, and `src/main.ts` as the composition root. The transport is an adapter; that is the whole claim.
- The API is reached through the port, over HTTP, exactly as any other client reaches it. The server holds no store of its own.
- The domain rules are repeated in this module rather than imported across modules ([ADR-0004](0004-independent-modules.md)), and they earn it: a move the API would refuse is refused here with the legal moves named, so the model corrects itself instead of discovering a 409.
- Every failure a caller can act on — a broken rule, an unreachable API — is returned as a tool result with `isError: true`. Only a bug in this module throws.
- Nothing writes to stdout. On a stdio server stdout is the protocol channel.
- Tools are tested through a real MCP client connected over a linked in-memory transport pair, asserting what `tools/list` advertises as well as what a call returns.

## Alternatives considered

- **MCP inside `api-go` or `api-ts`** — one fewer module, at the cost of a service that is both a long-running HTTP server and a subprocess speaking a second protocol on stdio.
- **A standalone server with its own store** — no dependency on the API, and immediately a second system of record.
- **Importing the domain from another module** — no repetition, but it couples two modules that must stay separately deletable.
- **Mocking the SDK in tests** — faster, and proves only that the mock matches the test's idea of the SDK. The in-memory transport pair is the SDK's own reference implementation and costs milliseconds.
- **An HTTP transport instead of stdio** — needed for a hosted server, and it brings origin validation, sessions and authorization with it. Stdio is what a local client starts, and the adapter boundary is where that choice is changed.

## Consequences

- The server's tools are exercised by CI, and the skill beside the module describes how to add another.
- The status rules now exist in three modules. Keeping them identical is a stated invariant in `AGENTS.md`, and a divergence is visible because all three are tested against the same cases.
- The server depends on the task API being reachable. A misconfiguration fails at startup rather than on every tool call, because a server that answers every call with a connection error keeps a model trying.
- Resources, prompts, sampling and HTTP transports are not implemented. Each is another registration in the same adapter.
