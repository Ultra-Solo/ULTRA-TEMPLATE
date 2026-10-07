# ADR-0030: Serve MCP over Streamable HTTP beside stdio

**Status:** Accepted · Amends [ADR-0007](0007-mcp-server-as-an-adapter.md) · **Date:** 2026-10-08

## Context

[ADR-0007](0007-mcp-server-as-an-adapter.md) chose stdio for the MCP server and named HTTP as the alternative it did not take: no session management, no port to configure, and every client of the time could spawn a subprocess. [ADR-0025](0025-prioritize-verified-foundation-before-capability-expansion.md) then deferred MCP HTTP behind the foundation work, to be revisited after a capability release; that release, v3.6.0, has shipped.

Two things changed since. The SDK (`@modelcontextprotocol/sdk` 2.3.1) now ships a stateless Streamable HTTP handler — `createMcpHandler` — that answers each request on its own with no session state and no web framework underneath. And adopters self-hosting the stack behind a proxy keep asking for a URL-type server: a client that cannot spawn subprocesses — a hosted assistant, a web client — can only reach an address.

## Decision

The server speaks both transports, chosen at startup:

- `MCP_TRANSPORT=stdio` (the default) serves the protocol on stdin and stdout, exactly as before.
- `MCP_TRANSPORT=http` serves Streamable HTTP at `POST /mcp`, on `MCP_HTTP_PORT` (default 3000; `0` asks the operating system for one). Any other path answers 404, and GET answers 405.

The HTTP form is stateless: every request stands alone, with no session and no authentication. A deployment that exposes it beyond localhost fronts it with a proxy that authenticates.

Nothing is written to stdout on either transport; diagnostics go to stderr. The registry package (`server.json`) keeps advertising the stdio form, which any registry client can start; the same image serves HTTP when the variable is set.

The tests drive the HTTP form through the SDK's client over a real socket, and the e2e walk runs every tool over both transports.

## Alternatives considered

- **Stay stdio only** — one transport, no new surface, but the deferral's trigger has arrived and URL-type clients still cannot use the server.
- **A second module for the HTTP form** — two modules repeating the same four tools and the same rules; the transports differ only in the adapter that moves bytes.
- **`@modelcontextprotocol/node`, the SDK's hosted form** — pulls `hono` transitively; the supply-chain rules would adopt a web framework for one endpoint the stateless handler already covers.
- **Hand-wired transport** — re-implements the protocol framing the SDK ships and tests; the adapter would own correctness it gets for free.
- **Stateful sessions** — session ids, resumable streams, eviction: complexity no consumer of these one-request tools needs.
- **A listen-address variable beside the port** — binding beyond localhost is the proxy's job; a port is enough.
- **A configurable endpoint path** — one path, `/mcp`, keeps the startup line, the client configuration and the docs single.

## Consequences

- Two transports must stay aligned: every tool change now holds over both, and the e2e walk says so on both lines.
- The image gains `EXPOSE 3000` beside the stdio form; the run instructions show both.
- No authentication or sessions ship, so a public deployment needs a proxy in front — stated in the README rather than hidden.
- The SDK floor rises to 2.3.1, where the stateless handler lives.
- The registry manifest stays stdio, so registry consumers see no change; HTTP adopters set the variable themselves.
