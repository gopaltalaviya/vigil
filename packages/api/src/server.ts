import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Logger } from "@vigil/core";
import type { Api } from "./api.js";

export interface ServerOptions {
  api: Api;
  /** Directory with the status page's static files. */
  staticDir: string;
  log: Logger;
  /** Requests one client may make per minute. */
  requestsPerMinute?: number;
  /** Seconds an API answer is reused before it is recomputed. */
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
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * HTTP front for the read-only API and the status page. GET and HEAD only,
 * per-client rate limiting, short-lived caching, and no path can escape the
 * static directory.
 */
export function createApiServer(options: ServerOptions): Server {
  const now = options.now ?? Date.now;
  const limit = options.requestsPerMinute ?? 120;
  const cacheMs = (options.cacheSecs ?? 5) * 1_000;
  const hits = new Map<string, { windowStart: number; count: number }>();
  const cache = new Map<
    string,
    { at: number; status: number; contentType: string; body: string }
  >();

  const allowed = (client: string): boolean => {
    const current = now();
    const entry = hits.get(client);
    if (entry === undefined || current - entry.windowStart >= 60_000) {
      if (hits.size > 10_000) hits.clear();
      hits.set(client, { windowStart: current, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };

  const send = (
    response: ServerResponse,
    head: boolean,
    status: number,
    contentType: string,
    body: string | Buffer,
    cacheControl: string,
  ): void => {
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      "content-type": contentType,
      "cache-control": cacheControl,
    });
    response.end(head ? undefined : body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const head = method === "HEAD";
    if (method !== "GET" && !head) {
      send(response, false, 405, "application/json", '{"error":"method not allowed"}', "no-store");
      return;
    }
    const client = request.socket.remoteAddress ?? "unknown";
    if (!allowed(client)) {
      send(response, head, 429, "application/json", '{"error":"too many requests"}', "no-store");
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz" || path === "/metrics" || path.startsWith("/api/")) {
      const cached = cache.get(path);
      if (cached !== undefined && now() - cached.at < cacheMs) {
        send(response, head, cached.status, cached.contentType, cached.body, "no-store");
        return;
      }
      const answer = options.api.handle(path);
      cache.set(path, { at: now(), ...answer });
      send(response, head, answer.status, answer.contentType, answer.body, "no-store");
      return;
    }

    const relative = normalize(path === "/" ? "index.html" : path.slice(1));
    const type = CONTENT_TYPES[extname(relative)];
    if (type === undefined || relative.startsWith("..") || relative.includes(`..${sep}`)) {
      send(response, head, 404, "application/json", '{"error":"not found"}', "no-store");
      return;
    }
    try {
      const file = await readFile(join(options.staticDir, relative));
      send(response, head, 200, type, file, "public, max-age=60");
    } catch {
      send(response, head, 404, "application/json", '{"error":"not found"}', "no-store");
    }
  };

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.log.error({ err: error }, "request failed");
      if (!response.headersSent) {
        send(response, false, 500, "application/json", '{"error":"internal error"}', "no-store");
      } else {
        response.end();
      }
    });
  });
}
