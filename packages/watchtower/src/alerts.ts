import type { AlertSeverity, HttpClient, Logger, Store, StoredAlert } from "@vigil/core";

/** A destination for alerts, such as a chat or an incident webhook. */
export interface AlertSink {
  readonly name: string;
  send(alert: StoredAlert): Promise<void>;
}

/** A condition worth reporting. `key` identifies the condition, so it is reported once. */
export interface AlertInput {
  key: string;
  severity: AlertSeverity;
  title: string;
  body: string;
}

const ICON: Record<AlertSeverity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

/** Plain-text rendering shared by every sink. */
export function formatAlert(alert: StoredAlert): string {
  return `${ICON[alert.severity]} Vigil ${alert.severity}: ${alert.title}\n\n${alert.body}`;
}

/** Sends alerts to a Telegram chat through a bot. The token never appears in logs or errors. */
export function telegramSink(http: HttpClient, botToken: string, chatId: string): AlertSink {
  return {
    name: "telegram",
    async send(alert) {
      await http.postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: formatAlert(alert),
        disable_web_page_preview: true,
      });
    },
  };
}

/** Posts alerts as JSON to an operator-supplied webhook. */
export function webhookSink(http: HttpClient, url: string): AlertSink {
  return {
    name: "webhook",
    async send(alert) {
      await http.postJson(url, {
        key: alert.key,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        createdAt: alert.createdAt,
        text: formatAlert(alert),
      });
    },
  };
}

export interface AlertDispatcherOptions {
  store: Store;
  sinks: readonly AlertSink[];
  log: Logger;
  /** Unix seconds. */
  now?: () => number;
}

/**
 * Records every alert durably before trying to deliver it, and retries until
 * every sink has accepted it. Delivery is at-least-once: after a partial
 * failure a sink that already accepted an alert may receive it again.
 */
export class AlertDispatcher {
  private readonly store: Store;
  private readonly sinks: readonly AlertSink[];
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(options: AlertDispatcherOptions) {
    this.store = options.store;
    this.sinks = options.sinks;
    this.log = options.log;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  /** Records the alert if its key is new. Returns whether it was new. */
  raise(input: AlertInput): boolean {
    const stored = this.store.recordAlert({ ...input, createdAt: this.now() });
    if (stored === undefined) return false;
    this.log.warn({ alert: input.key, severity: input.severity }, input.title);
    return true;
  }

  /** Tries to deliver every undelivered alert. Returns how many were delivered. */
  async flush(): Promise<number> {
    let delivered = 0;
    for (const alert of this.store.undeliveredAlerts()) {
      const results = await Promise.allSettled(this.sinks.map((sink) => sink.send(alert)));
      const failed = results.flatMap((result, i) =>
        result.status === "rejected"
          ? [{ sink: this.sinks[i]?.name, reason: result.reason as unknown }]
          : [],
      );
      if (failed.length === 0) {
        this.store.markAlertDelivered(alert.id, this.now());
        delivered += 1;
      } else {
        for (const failure of failed) {
          this.log.error(
            { alert: alert.key, sink: failure.sink, err: failure.reason },
            "alert delivery failed; will retry",
          );
        }
      }
    }
    return delivered;
  }
}
