import { createServer } from "@qorechain/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The Vigil MCP server: QoreChain's own read-only tools (blocks, transactions,
 * PQ status, contract reads) plus tools that answer from a Vigil API. Every
 * tool only reads. The server holds no key and sends no transaction.
 */
export interface VigilServerOptions {
  /** Base URL of a Vigil API, for example `http://127.0.0.1:8080`. */
  apiBase: string;
  /** Injectable `fetch`, also used for QoreChain's own tools. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds before a Vigil API call is abandoned. */
  timeoutMs?: number;
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function createVigilServer(options: VigilServerOptions): McpServer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const server = createServer({
    defaultNetwork: "testnet",
    ...(options.fetch === undefined ? {} : { upstream: { fetch: options.fetch } }),
  });
  const base = options.apiBase.replace(/\/+$/, "");

  const get = async (path: string): Promise<ToolResult> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      return failure(`the Vigil API at ${base} did not answer: ${(error as Error).message}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure(`the Vigil API answered ${String(response.status)} without JSON`);
    }
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : `HTTP ${String(response.status)}`;
      return failure(message);
    }
    const structured = (
      typeof body === "object" && body !== null && !Array.isArray(body) ? body : { value: body }
    ) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: structured,
    };
  };

  server.registerTool(
    "vigil_rollup_status",
    {
      title: "Vigil rollup status",
      description:
        "Status of the Vigil rollup and its watchtower: batches, verdicts, challenges, receipts, last tick and alerts.",
      annotations: READ_ONLY,
    },
    () => get("/api/overview"),
  );

  server.registerTool(
    "vigil_get_batch",
    {
      title: "Vigil batch",
      description:
        "One batch of the Vigil rollup: its roots, the watchtower's verdict, the PQ check of its transaction, its settlement receipt and decoded inbox entries.",
      inputSchema: { index: z.number().int().min(0).max(999_999_999) },
      annotations: READ_ONLY,
    },
    ({ index }) => get(`/api/batches/${String(index)}`),
  );

  server.registerTool(
    "vigil_get_account",
    {
      title: "Vigil L2 account",
      description: "Balance and history of one Vigil L2 account, by its 32-byte hex id.",
      inputSchema: { account: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/) },
      annotations: READ_ONLY,
    },
    ({ account }) => get(`/api/accounts/${account.replace(/^0x/, "").toLowerCase()}`),
  );

  server.registerTool(
    "vigil_rollup_audits",
    {
      title: "Audits of other rollups",
      description:
        "Vigil's read-only re-execution of every other rollup on the network: batches checked, and any provable fraud found.",
      annotations: READ_ONLY,
    },
    () => get("/api/rollups"),
  );

  return server;
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
