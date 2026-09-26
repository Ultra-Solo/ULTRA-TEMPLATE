import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "../application/task-service.ts";
import { DomainError, parseStatus } from "../domain/task.ts";

/** A request body larger than this is refused before it is parsed. */
const MAX_BODY_BYTES = 1024 * 1024;

const STATUS_BY_CODE = {
  EMPTY_TITLE: 422,
  TITLE_TOO_LONG: 422,
  UNKNOWN_STATUS: 422,
  INVALID_TRANSITION: 409,
  NOT_FOUND: 404,
} as const satisfies Record<DomainError["code"], number>;

class BadRequest extends Error {}

export type Log = (entry: Record<string, unknown>) => void;

/**
 * The HTTP transport: decode the request, call a use case, map the outcome to a response. It holds
 * no business rules, and the API it serves matches every other task service's route for route.
 */
export function createHandler(service: TaskService, log: Log) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await route(service, req, res);
    } catch (err) {
      if (err instanceof DomainError) {
        send(res, STATUS_BY_CODE[err.code], { error: err.message });
      } else if (err instanceof BadRequest) {
        send(res, 400, { error: err.message });
      } else {
        // The detail is logged and never returned to the client.
        log({ level: "error", msg: "request failed", method: req.method, path: req.url, error: String(err) });
        send(res, 500, { error: "internal error" });
      }
    }
  };
}

async function route(service: TaskService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // HEAD is answered wherever GET is, as HTTP requires; Node leaves the body off the response itself.
  const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    return method === "GET" ? send(res, 200, { status: "ok" }) : notAllowed(res);
  }
  if (path === "/api/tasks") {
    if (method === "GET") return send(res, 200, await service.list());
    if (method === "POST") {
      const body = await readObject(req, ["title"]);
      return send(res, 201, await service.create(optionalString(body, "title")));
    }
    return notAllowed(res);
  }

  const match = /^\/api\/tasks\/([^/]+)(\/status)?$/.exec(path);
  if (match?.[1] === undefined) return send(res, 404, { error: "not found" });
  const id = decodeSegment(match[1]);
  if (match[2] === undefined) {
    return method === "GET" ? send(res, 200, await service.get(id)) : notAllowed(res);
  }
  if (method !== "PATCH") return notAllowed(res);
  const body = await readObject(req, ["status"]);
  return send(res, 200, await service.transition(id, parseStatus(body["status"])));
}

/** Reads a size-bounded JSON object and refuses fields the endpoint does not document. */
async function readObject(req: IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Keep draining past the limit instead of destroying the stream, so the client still receives
    // the 400; the server's requestTimeout bounds how long that can take.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  const invalid = new BadRequest("request body must be a JSON object with only the documented fields");
  if (size > MAX_BODY_BYTES) throw invalid;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw invalid;
  return body as Record<string, unknown>;
}

/** A missing or null field reads as empty, which the domain rejects; a field of another type is malformed. */
function optionalString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequest(`${key} must be a string`);
  return value;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequest("malformed path");
  }
}

function notAllowed(res: ServerResponse): void {
  send(res, 405, { error: "method not allowed" });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
