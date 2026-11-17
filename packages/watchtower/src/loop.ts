import { VigilError, type Logger } from "@vigil/core";

export interface LoopOptions {
  /** One unit of work. A throw is logged and retried; it never ends the loop. */
  tick: () => Promise<unknown>;
  intervalMs: number;
  /** Aborting ends the loop after the tick in progress. */
  signal: AbortSignal;
  log: Logger;
  /** Longest pause after repeated failures. */
  maxBackoffMs?: number;
  onSuccess?: () => void;
  /** Called after each failed tick with the number of consecutive failures. */
  onFailure?: (failures: number, error: unknown) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Runs `tick` repeatedly until aborted. Failures double the pause up to a cap,
 * so a halted chain or a dead endpoint is polled gently and work resumes by
 * itself when the source comes back.
 */
export async function runLoop(options: LoopOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  let failures = 0;

  while (!options.signal.aborted) {
    try {
      await options.tick();
      failures = 0;
      options.onSuccess?.();
    } catch (error) {
      failures += 1;
      const code = error instanceof VigilError ? error.code : "UNEXPECTED";
      options.log.error({ err: error, code, failures }, "tick failed; will retry");
      options.onFailure?.(failures, error);
    }
    const pause =
      failures === 0
        ? options.intervalMs
        : Math.min(maxBackoffMs, options.intervalMs * 2 ** Math.min(failures, 10));
    await sleep(pause, options.signal);
  }
}
