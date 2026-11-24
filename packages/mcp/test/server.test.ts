import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createVigilServer } from "../src/server.js";

const API = "http://vigil.test";

function fakeFetch(seen: string[]): typeof fetch {
  return (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const json = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url === `${API}/api/overview`) return json(200, { rollupId: "vigil-1", batches: 30 });
    if (url === `${API}/api/batches/7`) return json(200, { index: 7, verdict: "valid" });
    if (url === `${API}/api/batches/8`) return json(404, { error: "no such batch" });
    if (url === `${API}/api/rollups`) return json(200, { ownRollup: "vigil-1", audits: [] });
    if (url.startsWith(`${API}/api/accounts/`)) return json(200, { account: url.split("/").pop() });
    if (url === `${API}/api/batches/9`)
      return Promise.resolve(new Response("oops", { status: 502 }));
    if (url === `${API}/api/batches/10`) return json(503, {});
    if (url === `${API}/api/batches/11`) return json(200, [1, 2]);
    if (url.startsWith(`${API}/down/`)) return Promise.reject(new Error("connection refused"));
    return json(404, { error: "not found" });
  };
}

async function connect(apiBase = API) {
  const seen: string[] = [];
  const server = createVigilServer({ apiBase, fetch: fakeFetch(seen) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, seen };
}

describe("Vigil MCP server", () => {
  it("lists QoreChain's tools and the Vigil tools, all read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_pq_status",
        "read_contract",
        "vigil_rollup_status",
        "vigil_get_batch",
        "vigil_get_account",
        "vigil_rollup_audits",
      ]),
    );
    for (const tool of tools.filter((t) => t.name.startsWith("vigil_"))) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("answers from the Vigil API", async () => {
    const { client, seen } = await connect();
    const status = await client.callTool({ name: "vigil_rollup_status", arguments: {} });
    expect(status.structuredContent).toEqual({ rollupId: "vigil-1", batches: 30 });
    const batch = await client.callTool({ name: "vigil_get_batch", arguments: { index: 7 } });
    expect(batch.structuredContent).toEqual({ index: 7, verdict: "valid" });
    const audits = await client.callTool({ name: "vigil_rollup_audits", arguments: {} });
    expect(audits.isError).toBeFalsy();
    const id = "AB".repeat(32);
    await client.callTool({ name: "vigil_get_account", arguments: { account: `0x${id}` } });
    expect(seen).toContain(`${API}/api/accounts/${id.toLowerCase()}`);
  });

  it("reports API errors and bad input as tool errors", async () => {
    const { client } = await connect();
    const missing = await client.callTool({ name: "vigil_get_batch", arguments: { index: 8 } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("no such batch");
    const bad = await client.callTool({
      name: "vigil_get_account",
      arguments: { account: "../x" },
    });
    expect(bad.isError).toBe(true);
  });

  it("handles answers without JSON, without an error field, and non-object JSON", async () => {
    const { client } = await connect();
    const call = (index: number) =>
      client.callTool({ name: "vigil_get_batch", arguments: { index } });
    const noJson = await call(9);
    expect(noJson.isError).toBe(true);
    expect(JSON.stringify(noJson.content)).toContain("502 without JSON");
    const noField = await call(10);
    expect(JSON.stringify(noField.content)).toContain("HTTP 503");
    expect((await call(11)).structuredContent).toEqual({ value: [1, 2] });
  });

  it("reports an unreachable API", async () => {
    const { client } = await connect(`${API}/down`);
    const result = await client.callTool({ name: "vigil_rollup_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("did not answer");
  });
});
