import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "vigil_session";

export interface SessionOptions {
  /** The operator's password. Sessions cannot be created without the right one. */
  password: string;
  /** Lifetime of a session in seconds. */
  ttlSecs?: number;
  /** Failed sign-ins one client may make per window before it is locked out. */
  maxAttempts?: number;
  /** Length of the lock-out window in seconds. */
  lockSecs?: number;
  /** Mark the cookie `Secure` (use when served over HTTPS). */
  secureCookie?: boolean;
  /** Unix seconds. */
  now?: () => number;
}

export type SignInResult =
  { ok: true; cookie: string } | { ok: false; reason: "wrong-password" | "locked" };

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

/**
 * Operator sessions, held in memory: a restart signs everyone out. The token
 * is random, sent only in an HttpOnly, SameSite=Strict cookie, and stored as
 * a hash. Password comparison takes the same time whatever the input, and
 * repeated failures from one client are locked out for a while.
 */
export class Sessions {
  private readonly passwordDigest: Buffer;
  private readonly ttlSecs: number;
  private readonly maxAttempts: number;
  private readonly lockSecs: number;
  private readonly secureCookie: boolean;
  private readonly now: () => number;
  private readonly active = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(options: SessionOptions) {
    this.passwordDigest = digest(options.password);
    this.ttlSecs = options.ttlSecs ?? 8 * 3_600;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.lockSecs = options.lockSecs ?? 300;
    this.secureCookie = options.secureCookie ?? false;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  signIn(password: unknown, client: string): SignInResult {
    if (this.isLocked(client)) return { ok: false, reason: "locked" };
    const matches =
      typeof password === "string" && timingSafeEqual(digest(password), this.passwordDigest);
    if (!matches) {
      this.recordFailure(client);
      return { ok: false, reason: "wrong-password" };
    }
    return { ok: true, cookie: this.grant(client) };
  }

  /** Whether `client` has failed too often recently to try again yet. */
  isLocked(client: string): boolean {
    const failed = this.failures.get(client);
    if (failed !== undefined && this.now() - failed.since >= this.lockSecs) {
      this.failures.delete(client);
    }
    return (this.failures.get(client)?.count ?? 0) >= this.maxAttempts;
  }

  /** Counts a failed sign-in, by password or by signature, towards the lock-out. */
  recordFailure(client: string): void {
    const entry = this.failures.get(client) ?? { count: 0, since: this.now() };
    entry.count += 1;
    this.failures.set(client, entry);
  }

  /** Starts a session for a client that has proved who it is; returns its cookie. */
  grant(client: string): string {
    this.failures.delete(client);
    const token = randomBytes(32).toString("hex");
    this.active.set(digest(token).toString("hex"), this.now() + this.ttlSecs);
    return this.cookie(token, this.ttlSecs);
  }

  /** Whether the cookie value belongs to a live session. */
  isSignedIn(token: string | undefined): boolean {
    if (token === undefined || !/^[0-9a-f]{64}$/.test(token)) return false;
    const key = digest(token).toString("hex");
    const expiry = this.active.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.active.delete(key);
      return false;
    }
    return true;
  }

  /** Ends the session and returns a cookie that clears it in the browser. */
  signOut(token: string | undefined): string {
    if (token !== undefined) this.active.delete(digest(token).toString("hex"));
    return this.cookie("", 0);
  }

  private cookie(value: string, maxAge: number): string {
    return (
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}` +
      (this.secureCookie ? "; Secure" : "")
    );
  }
}
