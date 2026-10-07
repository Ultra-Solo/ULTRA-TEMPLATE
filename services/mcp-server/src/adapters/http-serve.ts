/**
 * The inbound adapter for Streamable HTTP: the same tools the stdio transport serves, one POST at
 * a time, with nothing held between requests. A client that cannot start a subprocess — a hosted
 * one, one in a browser — connects to this instead.
 *
 * The SDK's handler answers both protocol eras and refuses what stateless serving cannot do (GET,
 * DELETE, session resumption) with 405 itself. What is left is bridging Node's request and response
 * types to the web-standard ones the handler speaks, which is all `@modelcontextprotocol/node`
 * would add — along with a web framework this module does not otherwise need.
 */
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

/** The one path the endpoint serves; a request for any other path is answered 404. */
export const MCP_HTTP_PATH = "/mcp";

export interface HttpServeOptions {
  /** The port to listen on; 0 lets the operating system assign one, which the handle reports. */
  readonly port: number;
  /** A fresh server for every request: stateless serving holds nothing between requests. */
  readonly makeServer: () => McpServer;
  /** Where the handler's out-of-band failures go; the composition root decides what to do with them. */
  readonly onError: (error: Error) => void;
}

export interface HttpServeHandle {
  /** The port the listener actually took. */
  readonly port: number;
  close(): Promise<void>;
}

/** One request, as the handler wants it: a web-standard Request built from Node's. */
function toWeb(req: IncomingMessage, url: URL): Request {
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.push([name, item]);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    // Node's parser answers a request with no method before it reaches here; the fallback is for the type alone.
    method: req.method ?? "GET",
    headers,
    // duplex is required by the Request constructor whenever the body is a stream.
    ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" as const } : {}),
  });
}

/** One response, as Node wants it: written back from the web-standard one the handler returned. */
async function fromWeb(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, [...response.headers]);
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), res);
}

export function serveHttp(options: HttpServeOptions): Promise<HttpServeHandle> {
  const handler = createMcpHandler(() => options.makeServer(), { onerror: options.onError });

  const serve = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (url.pathname !== MCP_HTTP_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`Not found. The MCP endpoint is ${MCP_HTTP_PATH}.`);
      return;
    }
    await fromWeb(await handler.fetch(toWeb(req, url)), res);
  };

  const server = createNodeServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void serve(req, res, url).catch((err: unknown) => {
      options.onError(err instanceof Error ? err : new Error(String(err)));
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal server error.");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      // Past this point an error is reported rather than thrown: the listener is up, the caller decides.
      server.off("error", reject);
      server.on("error", (err) => options.onError(err));
      const address = server.address();
      let closed = false;
      resolve({
        port: typeof address === "object" && address !== null ? address.port : options.port,
        close: async () => {
          // Idempotent: SIGINT and SIGTERM can both arrive, and a test may close before its cleanup.
          if (closed) return;
          closed = true;
          // In-flight exchanges are abandoned, the way a task service abandons a request on SIGTERM.
          await handler.close();
          server.closeAllConnections();
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          });
        },
      });
    });
  });
}
