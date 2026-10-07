/**
 * Configuration, read once at startup and refused rather than defaulted when it cannot be used.
 *
 * A misconfigured MCP server is worse than a stopped one: it speaks the protocol, answers every
 * tool call with a connection error, and the model keeps trying. So a bad value fails the process.
 */
export interface Config {
  readonly apiBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly transport: Transport;
  readonly httpPort: number;
}

export class ConfigError extends Error {}

/** How the server speaks: stdio, which a client starts as a subprocess, or http, which a client connects to. */
export type Transport = "stdio" | "http";

/** A task service on this machine, on the port every task service listens on by default. */
export const DEFAULT_TASK_API_URL = "http://localhost:8080";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_TRANSPORT: Transport = "stdio";
/** The port the http transport listens on; 8080 is the task API's, so this one sits beside it. */
export const DEFAULT_HTTP_PORT = 3000;

/** What a build that is not a release reports as its version, so it cannot be mistaken for one. */
export const DEVELOPMENT_VERSION = "0.0.0-dev";
// Semantic Versioning 2.0, as the release tags and the MCP Registry write versions.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The version this server reports to a client: MCP_SERVER_VERSION, which the image's build sets from
 * the release it is, or DEVELOPMENT_VERSION when that is unset or empty, as in a local build or a run
 * from source. It is what the image is, not a setting, so server.json does not advertise it.
 */
export function loadVersion(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env["MCP_SERVER_VERSION"] ?? "";
  if (raw === "") return DEVELOPMENT_VERSION;
  if (!SEMVER.test(raw)) throw new ConfigError(`MCP_SERVER_VERSION must be a version such as 1.2.0, got "${raw}"`);
  return raw;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const rawUrl = env["TASK_API_URL"] ?? DEFAULT_TASK_API_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`TASK_API_URL must be an absolute URL, got "${rawUrl}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`TASK_API_URL must be http or https, got "${url.protocol.replace(":", "")}"`);
  }

  const rawTimeout = env["TASK_API_TIMEOUT_MS"] ?? "";
  // Digits only: Number() would also accept "0x1F90", "8e3" and " 10000".
  const timeout = rawTimeout === "" ? DEFAULT_TIMEOUT_MS : /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new ConfigError(`TASK_API_TIMEOUT_MS must be a positive whole number of milliseconds, got "${rawTimeout}"`);
  }

  const rawTransport = env["MCP_TRANSPORT"] ?? "";
  if (rawTransport !== "" && rawTransport !== "stdio" && rawTransport !== "http") {
    throw new ConfigError(`MCP_TRANSPORT must be stdio or http, got "${rawTransport}"`);
  }
  const transport: Transport = rawTransport === "" ? DEFAULT_TRANSPORT : rawTransport;

  const rawPort = env["MCP_HTTP_PORT"] ?? "";
  const httpPort = rawPort === "" ? DEFAULT_HTTP_PORT : /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  // 0 is allowed: it asks the operating system for a port, which the startup line then reports.
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65_535) {
    throw new ConfigError(`MCP_HTTP_PORT must be a whole number from 0 to 65535, got "${rawPort}"`);
  }

  return { apiBaseUrl: url.toString(), requestTimeoutMs: timeout, transport, httpPort };
}
