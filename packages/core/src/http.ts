import { HttpStatusError, SourceUnavailableError, redactUrl } from "./errors.js";

/** The subset of `fetch` Vigil relies on; the global `fetch` satisfies it. */
export type Transport = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<TransportResponse>;

export interface TransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface HttpClientOptions {
  /** Label used in errors and metrics, for example `testnet-rest`. */
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  requestsPerMinute?: number;
  /** Consecutive failed requests before the circuit opens. */
  breakerThreshold?: number;
  /** How long an open circuit refuses requests before letting one probe through. */
  breakerCooldownMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Set when request URLs carry credentials (webhooks, bot tokens): errors show the host only. */
  secretUrls?: boolean;
  transport?: Transport;
  /** Injectable clock, sleep and randomness, so behaviour is testable. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/** Public endpoints reject some default library user agents; identify as a browser. */
const USER_AGENT = "Mozilla/5.0 (compatible; Vigil/0.1)";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * HTTP client for public chain endpoints: per-request timeout, bounded retries
 * with exponential backoff and full jitter, a token-bucket rate limit, and a
 * circuit breaker so a dead endpoint fails fast instead of piling up requests.
 */
export class HttpClient {
  readonly source: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly secretUrls: boolean;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;

  private consecutiveFailures = 0;
  private openedAt: number | undefined;

  constructor(options: HttpClientOptions) {
    this.source = options.source;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.breakerThreshold = options.breakerThreshold ?? 5;
    this.breakerCooldownMs = options.breakerCooldownMs ?? 30_000;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.secretUrls = options.secretUrls ?? false;
    this.transport = options.transport ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;

    const perMinute = options.requestsPerMinute ?? 300;
    this.capacity = Math.max(1, Math.min(perMinute, 20));
    this.refillPerMs = perMinute / 60_000;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Whether the circuit is currently refusing requests. */
  get isOpen(): boolean {
    return this.openedAt !== undefined && this.now() - this.openedAt < this.breakerCooldownMs;
  }

  /**
   * Performs a request and returns the response for any non-retryable status,
   * including 4xx, so callers can tell "not found" from "unreachable".
   */
  async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<TransportResponse> {
    if (this.isOpen) {
      throw new SourceUnavailableError(this.source, "circuit open after repeated failures");
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.takeToken();
      try {
        const response = await this.transport(url, {
          ...init,
          headers: { accept: "application/json", "user-agent": USER_AGENT, ...init.headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!RETRYABLE_STATUS.has(response.status)) {
          this.recordSuccess();
          return response;
        }
        lastError = new HttpStatusError(url, response.status, this.secretUrls);
        if (attempt < this.maxRetries) {
          await this.sleep(this.delayFor(attempt, response.headers?.get("retry-after") ?? null));
        }
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) await this.sleep(this.delayFor(attempt, null));
      }
    }

    this.recordFailure();
    throw new SourceUnavailableError(
      this.source,
      `no usable answer from ${redactUrl(url, this.secretUrls)} after ${String(this.maxRetries + 1)} attempts`,
      { cause: lastError },
    );
  }

  /** GETs a URL and parses JSON; a non-2xx answer becomes an `HttpStatusError`. */
  async getJson(url: string): Promise<unknown> {
    const response = await this.request(url);
    if (!response.ok) throw new HttpStatusError(url, response.status, this.secretUrls);
    return response.json();
  }

  /** POSTs a JSON body and parses the JSON answer. */
  async postJson(url: string, body: unknown): Promise<unknown> {
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new HttpStatusError(url, response.status, this.secretUrls);
    return response.json();
  }

  /** Adapter with the plain `fetch` shape, for libraries that accept a custom fetch. */
  asFetch(): (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<TransportResponse> {
    return (url, init) => this.request(url, init);
  }

  private delayFor(attempt: number, retryAfter: string | null): number {
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    const jittered = Math.floor(this.random() * ceiling);
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const requested = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
    return Math.min(this.maxDelayMs, Math.max(jittered, requested));
  }

  private async takeToken(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (now - this.lastRefill) * this.refillPerMs,
      );
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) / this.refillPerMs));
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.breakerThreshold) this.openedAt = this.now();
  }
}
