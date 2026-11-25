import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Logger } from "@vigil/core";
import type { Api, ApiResponse } from "./api.js";

/** A request handed to an extra route handler (the operator console). */
export interface RouteRequest {
  method: "GET" | "POST";
  path: string;
  /** Parsed JSON body of a POST; `undefined` for GET. */
  body: unknown;
  cookies: Readonly<Record<string, string>>;
  /** Address used for rate limiting. */
  client: string;
}

/** An API answer that may also set response headers, for example a session cookie. */
export type RouteResponse = ApiResponse & { headers?: Record<string, string> };

/** Handles a request, or returns `undefined` to let the read-only API answer. */
export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse | undefined>;

export interface ServerOptions {
  api: Api;
  /** Directory with the web app's static files. */
  staticDir: string;
  /** Directory with the Markdown docs, served at /docs/NAME.md. */
  docsDir?: string;
  log: Logger;
  /**
   * Extra routes with side effects. Without it the server is read-only and
   * refuses every method except GET and HEAD.
   */
  routes?: RouteHandler;
  /** Requests one client may make per minute. */
  requestsPerMinute?: number;
  /**
   * Set when a reverse proxy on the same host fronts this server. The client address is then
   * taken from the last `X-Forwarded-For` entry, which that proxy wrote; otherwise every visitor
   * would share the proxy's address and one rate limit.
   */
  trustProxy?: boolean;
  /** Seconds a read-only API answer is reused before it is recomputed. */
  cacheSecs?: number;
  /** Milliseconds. */
  now?: () => number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://evm-testnet.qore.host; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const MAX_BODY_BYTES = 16 * 1024;
const JSON_TYPE = "application/json; charset=utf-8";

/** Paths whose answers depend only on the database and may be reused briefly. */
const CACHEABLE = new Set(["/healthz", "/metrics", "/api/overview"]);

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * HTTP front for the API and the web app. Per-client rate limiting, strict
 * security headers, and no path can escape the static directory. Requests
 * that change anything exist only when `routes` is given; they must be JSON,
 * same-origin, and carry a custom header that a cross-site form cannot send.
 */
export function createApiServer(options: ServerOptions): Server {
  const now = options.now ?? Date.now;
  const limit = options.requestsPerMinute ?? 120;
  const cacheMs = (options.cacheSecs ?? 5) * 1_000;
  const hits = new Map<string, { windowStart: number; count: number }>();
  const cache = new Map<string, { at: number } & ApiResponse>();

  const allowed = (client: string): boolean => {
    const current = now();
    const entry = hits.get(client);
    if (entry === undefined || current - entry.windowStart >= 60_000) {
      if (hits.size > 10_000) {
        for (const [key, value] of hits) {
          if (current - value.windowStart >= 60_000) hits.delete(key);
        }
        if (hits.size > 10_000) hits.clear();
      }
      hits.set(client, { windowStart: current, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };

  const send = (
    response: ServerResponse,
    head: boolean,
    answer: { status: number; contentType: string; body: string | Buffer },
    cacheControl: string,
    extra: Record<string, string> = {},
  ): void => {
    response.writeHead(answer.status, {
      ...SECURITY_HEADERS,
      "content-type": answer.contentType,
      "cache-control": cacheControl,
      ...extra,
    });
    response.end(head ? undefined : answer.body);
  };
  const failure = (status: number, message: string) => ({
    status,
    contentType: JSON_TYPE,
    body: JSON.stringify({ error: message }),
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const head = method === "HEAD";
    const writes = method === "POST" && options.routes !== undefined;
    if (method !== "GET" && !head && !writes) {
      send(response, false, failure(405, "method not allowed"), "no-store");
      return;
    }
    const forwarded = options.trustProxy === true ? request.headers["x-forwarded-for"] : undefined;
    const lastHop = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)
      ?.split(",")
      .at(-1)
      ?.trim();
    const client = lastHop ?? request.socket.remoteAddress ?? "unknown";
    if (!allowed(client)) {
      send(response, head, failure(429, "too many requests"), "no-store");
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const isApi = path === "/healthz" || path === "/metrics" || path.startsWith("/api/");

    if (writes) {
      // A browser will not attach this header to a cross-site form or image request.
      if (!isApi || request.headers["x-vigil-request"] !== "1") {
        send(response, false, failure(403, "forbidden"), "no-store");
        return;
      }
      if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
        send(response, false, failure(415, "send JSON"), "no-store");
        return;
      }
    }

    if (isApi) {
      if (options.routes !== undefined) {
        let body: unknown;
        if (writes) {
          try {
            body = await readJsonBody(request);
          } catch {
            send(response, false, failure(400, "invalid request body"), "no-store");
            return;
          }
        }
        const routed = await options.routes({
          method: writes ? "POST" : "GET",
          path,
          body,
          cookies: parseCookies(request.headers.cookie),
          client,
        });
        if (routed !== undefined) {
          send(response, head, routed, "no-store", routed.headers);
          return;
        }
        if (writes) {
          send(response, false, failure(404, "not found"), "no-store");
          return;
        }
      }
      const cached = cache.get(path);
      if (cached !== undefined && now() - cached.at < cacheMs) {
        send(response, head, cached, "no-store");
        return;
      }
      const answer = options.api.handle(path);
      // Only known, successful answers are cached, so arbitrary paths cannot grow the cache.
      if (answer.status === 200 && CACHEABLE.has(path)) cache.set(path, { at: now(), ...answer });
      send(response, head, answer, "no-store");
      return;
    }

    const doc = /^\/docs\/([A-Z][A-Z_]{1,40})\.md$/.exec(path);
    if (doc?.[1] !== undefined && options.docsDir !== undefined) {
      try {
        const file = await readFile(join(options.docsDir, `${doc[1]}.md`));
        send(
          response,
          head,
          { status: 200, contentType: "text/markdown; charset=utf-8", body: file },
          "no-cache",
        );
      } catch {
        send(response, head, failure(404, "not found"), "no-store");
      }
      return;
    }

    const relative = normalize(path === "/" ? "index.html" : path.slice(1));
    const type = CONTENT_TYPES[extname(relative)];
    if (type === undefined || relative.startsWith("..") || relative.includes(`..${sep}`)) {
      send(response, head, failure(404, "not found"), "no-store");
      return;
    }
    try {
      const file = await readFile(join(options.staticDir, relative));
      send(response, head, { status: 200, contentType: type, body: file }, "no-cache");
    } catch {
      send(response, head, failure(404, "not found"), "no-store");
    }
  };

  return createServer((request, response) => {
    handle(request, response).catch((problem: unknown) => {
      options.log.error({ err: problem }, "request failed");
      if (!response.headersSent) {
        send(response, false, failure(500, "internal error"), "no-store");
      } else {
        response.end();
      }
    });
  });
}
