# ADR-0021: Bound request receive time

**Status:** Accepted · Amends [ADR-0018](0018-every-task-service-reads-and-answers-alike.md) · **Date:** 2026-10-01

## Context

ADR-0018 holds the task services to the same observable API behavior. A slow-client experiment found that Go and Node stopped reading incomplete requests after a bounded total time, while Python's socket timeout only bounded inactivity: a client that periodically sent bytes kept a Python connection open and could keep a worker thread occupied. Python also had no separate absolute deadline for receiving headers.

The three HTTP servers do not promise the same timeout response. Python's WSGI application can also run under a production server selected by the adopter, which owns its transport timeouts.

## Decision

The task services' development servers enforce absolute receive deadlines: headers must arrive within the `receiveTimeoutsMs.headers` limit in `scripts/contract/tasks-api.json`, and the complete request (headers and body) must arrive within `receiveTimeoutsMs.request`. The contract checker tests successful delivery within each limit and termination of slow trickles beyond each limit. A timed-out request may receive a server-specific response or have its connection closed.

The Python service's production WSGI server is an adopter's deployment choice and must be configured to enforce equivalent deadlines. No particular timeout response is part of the shared API contract.

## Alternatives considered

- **Keep only Python's inactivity timeout** — a slow trickle would continue holding a request thread, unlike the other services' bounded request reads.
- **Require one exact timeout status** — the underlying servers report timeouts differently, and that response is outside the task API behavior the services share.
- **Configure production WSGI servers in the example service** — the project intentionally leaves production WSGI deployment to adopters.

## Consequences

- Slow clients cannot hold a development-server connection indefinitely by periodically sending bytes.
- The contract check spends additional time exercising slow requests and accepts server-specific timeout responses.
- Adopters running the Python WSGI application in production must set equivalent server-level receive deadlines themselves.
