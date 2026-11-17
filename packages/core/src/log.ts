import { pino, type Logger } from "pino";

export type { Logger };

const SECRET_FIELDS = [
  "mnemonic",
  "secrets",
  "seed",
  "secretKey",
  "privateKey",
  "pqcSeedHex",
  "telegramBotToken",
  "webhookUrl",
];

/** Field names that must never reach a log line, at the top level or one level down. */
const REDACTED_PATHS = [...SECRET_FIELDS, ...SECRET_FIELDS.map((f) => `*.${f}`), "config.alerts"];

/** Creates a JSON logger. Pass heights and amounts as strings: bigint is not JSON. */
export function createLogger(options: {
  level?: string;
  service: string;
  destination?: pino.DestinationStream;
}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { service: options.service },
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err },
    },
    options.destination,
  );
}
