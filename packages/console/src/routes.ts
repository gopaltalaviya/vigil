import type { RouteHandler, RouteResponse } from "@vigil/api";
import type { Logger } from "@vigil/core";
import { InputError } from "@vigil/wallet";
import { publicMessage, type Operator } from "./operator.js";
import { SESSION_COOKIE, type Sessions } from "./session.js";
import { SiwqError, type SiwqSignIn } from "./siwq.js";

const JSON_TYPE = "application/json; charset=utf-8";
const json = (status: number, value: unknown, headers?: Record<string, string>): RouteResponse => ({
  status,
  contentType: JSON_TYPE,
  body: JSON.stringify(value),
  ...(headers === undefined ? {} : { headers }),
});

/**
 * Routes of the operator console. Signing in is the only thing possible
 * without a session; every wallet route requires one. Actions run one at a
 * time, because base-chain transactions from one account must not overlap.
 */
export function createConsoleRoutes(options: {
  operator: Operator;
  sessions: Sessions;
  /** Sign In With QoreChain; without it only the password works. */
  siwq?: SiwqSignIn;
  log: Logger;
}): RouteHandler {
  const { operator, sessions, siwq, log } = options;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  const actions: Record<string, (body: unknown) => Promise<unknown>> = {
    "/api/wallet/account": () => Promise.resolve(operator.createAccount()),
    "/api/wallet/deposit": (body) => operator.deposit(body),
    "/api/wallet/transfer": (body) => operator.transfer(body),
    "/api/wallet/withdraw": (body) => operator.withdraw(body),
    "/api/wallet/claim": () => operator.claim(),
    "/api/wallet/memo-key": () => operator.publishMemoKey(),
  };

  return async ({ method, path, body, cookies, client }) => {
    const token = cookies[SESSION_COOKIE];
    const signedIn = sessions.isSignedIn(token);

    if (path === "/api/session") {
      if (method === "GET") return json(200, { console: true, signedIn, siwq: siwq !== undefined });
      const password = (body as { password?: unknown } | undefined)?.password;
      const result = sessions.signIn(password, client);
      if (result.ok) return json(200, { signedIn: true }, { "set-cookie": result.cookie });
      log.warn({ client, reason: result.reason }, "console sign-in refused");
      return result.reason === "locked"
        ? json(429, { error: "too many attempts; try again in a few minutes" })
        : json(401, { error: "wrong password" });
    }
    if (siwq !== undefined && method === "POST" && path === "/api/siwq/challenge") {
      if (sessions.isLocked(client))
        return json(429, { error: "too many attempts; try again later" });
      try {
        const address = (body as { address?: unknown } | undefined)?.address;
        return json(200, await siwq.challenge(address));
      } catch (error) {
        if (error instanceof SiwqError) return json(400, { error: error.message });
        log.error({ err: error }, "sign-in challenge failed");
        return json(502, { error: "could not start the sign-in" });
      }
    }
    if (siwq !== undefined && method === "POST" && path === "/api/siwq/verify") {
      if (sessions.isLocked(client))
        return json(429, { error: "too many attempts; try again later" });
      let result;
      try {
        result = await siwq.verify(body);
      } catch (error) {
        log.error({ err: error }, "sign-in check failed");
        return json(502, { error: "could not read the account's key from the chain" });
      }
      if (!result.ok) {
        sessions.recordFailure(client);
        log.warn({ client, reason: result.reason }, "console sign-in refused");
        return json(401, { error: result.reason });
      }
      log.info({ address: result.address, format: result.format }, "signed in with QoreChain");
      return json(
        200,
        { signedIn: true, address: result.address },
        { "set-cookie": sessions.grant(client) },
      );
    }
    if (path === "/api/session/logout" && method === "POST") {
      return json(200, { signedIn: false }, { "set-cookie": sessions.signOut(token) });
    }

    const isWallet = path === "/api/wallet" || path.startsWith("/api/wallet/");
    if (!isWallet) return undefined;
    if (!signedIn) return json(401, { error: "sign in first" });

    try {
      if (path === "/api/wallet" && method === "GET") return json(200, await operator.view());
      const action = method === "POST" ? actions[path] : undefined;
      if (action === undefined) return json(404, { error: "not found" });
      return json(200, await serial(() => action(body)));
    } catch (error) {
      if (!(error instanceof InputError)) log.error({ path, err: error }, "console action failed");
      return json(error instanceof InputError ? 400 : 502, { error: publicMessage(error) });
    }
  };
}
