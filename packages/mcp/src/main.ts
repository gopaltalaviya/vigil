#!/usr/bin/env node
/**
 * `vigil-mcp`: the Vigil MCP server over stdio, for AI clients.
 *
 *   VIGIL_API_URL=http://127.0.0.1:8080 vigil-mcp
 *
 * It reads from a Vigil API (default the local one) and from QoreChain's public
 * testnet endpoints. It holds no key and sends nothing.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVigilServer } from "./server.js";

const configured = process.env.VIGIL_API_URL?.trim() ?? "";
const apiBase = configured === "" ? "http://127.0.0.1:8080" : configured;
const server = createVigilServer({ apiBase });
await server.connect(new StdioServerTransport());
process.stderr.write(`vigil-mcp: ready, reading ${apiBase}\n`);
