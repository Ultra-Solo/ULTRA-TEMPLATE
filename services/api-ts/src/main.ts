/**
 * Composition root: the only module that reads the environment and chooses concrete adapters. It
 * holds wiring and nothing else.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after } from "./adapters/after.ts";
import { createHandler, type Log } from "./adapters/http.ts";
import { MemoryTaskRepository } from "./adapters/memory-task-repository.ts";
import { withRequestLog } from "./adapters/request-log.ts";
import { TaskService } from "./application/task-service.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";

const log: Log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  log({ level: "error", msg: "invalid configuration", error: err.message });
  process.exit(2);
}

const service = new TaskService({
  repository: new MemoryTaskRepository(),
  clock: { now: () => new Date().toISOString() },
  ids: { next: () => randomUUID() },
});

const handler = withRequestLog(createHandler(service, log), log, { monotonic: () => performance.now(), newId: () => randomUUID() });
// Without these a client that sends headers or a body slowly holds a connection open indefinitely.
const server = createServer({ headersTimeout: 5_000, requestTimeout: 15_000, connectionsCheckingInterval: 1_000 }, handler);
server.listen(config.port, () => log({ level: "info", msg: "listening", port: config.port, shutdownTimeoutMs: config.shutdownTimeoutMs }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log({ level: "info", msg: "shutting down", signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    after(config.shutdownTimeoutMs, () => process.exit(1));
  });
}
