/** Stable machine-readable codes for every error Vigil raises on purpose. */
export type VigilErrorCode =
  | "CONFIG_INVALID"
  | "HTTP_STATUS"
  | "SOURCE_UNAVAILABLE"
  | "INTEGRITY"
  | "TX_FAILED"
  | "TX_UNCONFIRMED"
  | "STORE";

/** Base class: carries a code and optional structured details, never secrets. */
export class VigilError extends Error {
  readonly code: VigilErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: VigilErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** The environment is missing a value or holds a malformed one. */
export class ConfigError extends VigilError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("CONFIG_INVALID", message, details);
  }
}

/** An endpoint answered with a status that retrying will not fix. */
export class HttpStatusError extends VigilError {
  readonly status: number;

  constructor(url: string, status: number, hostOnly = false) {
    super("HTTP_STATUS", `HTTP ${String(status)} from ${redactUrl(url, hostOnly)}`, { status });
    this.status = status;
  }
}

/** An endpoint stayed unreachable after every retry, or its circuit is open. */
export class SourceUnavailableError extends VigilError {
  constructor(source: string, reason: string, options?: ErrorOptions) {
    super("SOURCE_UNAVAILABLE", `${source} is unavailable: ${reason}`, { source }, options);
  }
}

/** Data read from the chain or from disk does not match its commitment. */
export class IntegrityError extends VigilError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("INTEGRITY", message, details);
  }
}

/** A transaction was included but the chain rejected it. */
export class TxFailedError extends VigilError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("TX_FAILED", message, details);
  }
}

/** A transaction was broadcast (or attempted) but its outcome could not be confirmed. */
export class TxUnconfirmedError extends VigilError {
  constructor(message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super("TX_UNCONFIRMED", message, details, options);
  }
}

/** The local database is unusable or holds an unexpected schema. */
export class StoreError extends VigilError {
  constructor(message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super("STORE", message, details, options);
  }
}

/** Strips query strings, credentials and path tokens so URLs are safe to log. */
export function redactUrl(url: string, hostOnly = false): string {
  try {
    const parsed = new URL(url);
    // A webhook URL is itself a credential: show the host and nothing else.
    if (hostOnly) return `${parsed.protocol}//${parsed.host}/[redacted]`;
    // Some APIs carry a credential in the path (for example `/bot<token>/sendMessage`).
    const path = parsed.pathname.replace(/\/bot[^/]+/g, "/bot[redacted]");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return "<invalid url>";
  }
}
