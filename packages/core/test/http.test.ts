import { describe, expect, it } from "vitest";
import {
  HttpClient,
  HttpStatusError,
  SourceUnavailableError,
  type Transport,
  type TransportResponse,
} from "../src/index.js";

function response(status: number, body: unknown = {}, retryAfter?: string): TransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (name) => (name === "retry-after" ? (retryAfter ?? null) : null) },
    json: () => Promise.resolve(body),
  };
}

/** A client with a scripted transport and a virtual clock: no real waiting. */
function harness(
  script: (TransportResponse | Error)[],
  options: { maxRetries?: number; requestsPerMinute?: number; breakerThreshold?: number } = {},
) {
  let clock = 0;
  const sleeps: number[] = [];
  const seen: { url: string; headers: Record<string, string> | undefined }[] = [];
  const transport: Transport = (url, init) => {
    seen.push({ url, headers: init?.headers });
    const next = script.shift();
    if (next === undefined) return Promise.reject(new Error("script exhausted"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const client = new HttpClient({
    source: "test-rest",
    transport,
    maxRetries: options.maxRetries ?? 3,
    requestsPerMinute: options.requestsPerMinute ?? 600,
    breakerThreshold: options.breakerThreshold ?? 2,
    breakerCooldownMs: 30_000,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    random: () => 0.5,
  });
  return { client, sleeps, seen, advance: (ms: number) => (clock += ms) };
}

describe("HttpClient", () => {
  it("returns JSON and identifies itself with a browser-style user agent", async () => {
    const { client, seen } = harness([response(200, { height: "1" })]);
    await expect(client.getJson("https://node.example/status")).resolves.toEqual({ height: "1" });
    expect(seen[0]?.headers?.["user-agent"]).toMatch(/^Mozilla\/5\.0/);
  });

  it("retries transient failures with growing, jittered delays", async () => {
    const { client, sleeps } = harness([
      response(503),
      new Error("socket hang up"),
      response(502),
      response(200, { ok: true }),
    ]);
    await expect(client.getJson("https://node.example/x")).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([125, 250, 500]);
  });

  it("honours a Retry-After header that asks for a longer wait", async () => {
    const { client, sleeps } = harness([response(429, {}, "3"), response(200)]);
    await client.getJson("https://node.example/x");
    expect(sleeps).toEqual([3_000]);
  });

  it("does not retry a definitive answer such as 404", async () => {
    const { client, seen } = harness([response(404)]);
    const error = await client
      .getJson("https://node.example/missing?key=secret")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(404);
    expect((error as Error).message).not.toContain("secret");
    expect(seen).toHaveLength(1);
  });

  it("gives up after the retry budget and reports the source as unavailable", async () => {
    const { client, seen } = harness([response(500), response(500), response(500)], {
      maxRetries: 2,
    });
    const error = await client.getJson("https://node.example/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect((error as SourceUnavailableError).details).toEqual({ source: "test-rest" });
    expect(seen).toHaveLength(3);
  });

  it("opens the circuit after repeated failures and closes it after a cooldown", async () => {
    const { client, seen, advance } = harness(
      [response(500), response(500), response(200, { back: true })],
      { maxRetries: 0, breakerThreshold: 2 },
    );
    await expect(client.getJson("https://node.example/x")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
    await expect(client.getJson("https://node.example/x")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
    expect(client.isOpen).toBe(true);

    await expect(client.getJson("https://node.example/x")).rejects.toThrow(/circuit open/);
    expect(seen).toHaveLength(2);

    advance(30_001);
    expect(client.isOpen).toBe(false);
    await expect(client.getJson("https://node.example/x")).resolves.toEqual({ back: true });
  });

  it("spaces requests out once the rate-limit burst is used up", async () => {
    const script = Array.from({ length: 4 }, () => response(200));
    const { client, sleeps } = harness(script, { requestsPerMinute: 2 });
    for (let i = 0; i < 4; i++) await client.getJson("https://node.example/x");
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  it("posts JSON bodies and exposes a fetch-shaped adapter", async () => {
    const { client, seen } = harness([response(200, { result: "0x1" }), response(404)]);
    await expect(
      client.postJson("https://evm.example", { method: "eth_chainId" }),
    ).resolves.toEqual({ result: "0x1" });
    expect(seen[0]?.headers?.["content-type"]).toBe("application/json");
    const viaFetch = await client.asFetch()("https://node.example/none");
    expect(viaFetch.status).toBe(404);
  });
});
