/**
 * The composition root: read configuration, build the adapters, serve them over stdio or HTTP.
 *
 * Nothing is ever written to stdout. On a stdio server stdout IS the protocol channel, and one
 * stray console.log corrupts the stream in a way that reads to the client as a malformed server.
 * The HTTP transport keeps the rule too, so nothing that runs this module has to reason about
 * which transport is serving. Diagnostics go to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHttpTaskGateway } from "./adapters/http-task-gateway.ts";
import { type HttpServeHandle, MCP_HTTP_PATH, serveHttp } from "./adapters/http-serve.ts";
import { createServer } from "./adapters/mcp.ts";
import { type Config, ConfigError, loadConfig, loadVersion } from "./config.ts";

let config: Config;
let version: string;
try {
  config = loadConfig(process.env);
  version = loadVersion(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`mcp-server: ${err.message}`);
  process.exit(2);
}

const gateway = createHttpTaskGateway({ baseUrl: config.apiBaseUrl, timeoutMs: config.requestTimeoutMs });
const tools = () => createServer(gateway, { version });
const stop = (close: () => Promise<void>) => async () => {
  await close();
  process.exit(0);
};

if (config.transport === "http") {
  let handle: HttpServeHandle;
  try {
    handle = await serveHttp({
      port: config.httpPort,
      makeServer: tools,
      onError: (err) => console.error(`mcp-server ${version}: ${err.message}`),
    });
  } catch (err) {
    console.error(`mcp-server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  console.error(`mcp-server ${version}: serving tasks from ${config.apiBaseUrl} over http on port ${handle.port} at ${MCP_HTTP_PATH}`);
  process.on("SIGINT", stop(handle.close));
  process.on("SIGTERM", stop(handle.close));
} else {
  const handle = serveStdio(tools);
  console.error(`mcp-server ${version}: serving tasks from ${config.apiBaseUrl} over stdio`);
  process.on(
    "SIGINT",
    stop(() => handle.close()),
  );
  process.on(
    "SIGTERM",
    stop(() => handle.close()),
  );
}
