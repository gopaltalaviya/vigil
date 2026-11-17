import { z } from "zod";
import { ConfigError } from "./errors.js";

const url = z.url({ protocol: /^https?$/ });
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const schema = z.object({
  VIGIL_MODE: z.enum(["own", "shared"]).default("shared"),
  QORE_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  QORE_CHAIN_ID: z.string().trim().min(1).default("qorechain-diana"),
  QORE_RPC_URL: url.default("https://rpc-testnet.qore.host"),
  QORE_REST_URL: url.default("https://api-testnet.qore.host"),
  QORE_EVM_RPC_URL: url.default("https://evm-testnet.qore.host"),
  ROLLUP_ID: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "must be a lower-case rollup id"),
  VIGIL_DATA_DIR: z.string().trim().min(1).default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
  HTTP_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(300),
  QORE_GAS_PRICE: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?uqor$/, "must look like 0.15uqor")
    .default("0.15uqor"),
  VIGIL_KEYSTORE_PASSPHRASE: optionalText,
  QORE_MNEMONIC: optionalText,
  QORE_PQC_SEED_HEX: optionalText.refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), {
    message: "must be 32 bytes of hex",
  }),
  ALERT_WEBHOOK_URL: optionalText.pipe(url.optional()),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_CHAT_ID: optionalText,
});

/**
 * Reads an integer setting such as a port or an interval. A value that is not
 * a whole number inside the allowed range is a configuration error, never a
 * silent fallback: a mistyped interval must not turn into a busy loop.
 */
export function envInt(
  name: string,
  fallback: number,
  range: { min: number; max: number },
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ConfigError(`invalid configuration: ${name}`, {
      problems: [{ variable: name, problem: "not an integer in range" }],
    });
  }
  return value;
}

/** Validated runtime settings. Secrets are present here and nowhere else. */
export type VigilConfig = Readonly<{
  mode: "own" | "shared";
  network: "testnet" | "mainnet";
  chainId: string;
  rpcUrl: string;
  restUrl: string;
  evmRpcUrl: string;
  rollupId: string;
  dataDir: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  http: Readonly<{ timeoutMs: number; maxRetries: number; requestsPerMinute: number }>;
  gasPrice: string;
  secrets: Readonly<{
    mnemonic: string | undefined;
    pqcSeedHex: string | undefined;
    keystorePassphrase: string | undefined;
  }>;
  alerts: Readonly<{
    webhookUrl: string | undefined;
    telegramBotToken: string | undefined;
    telegramChatId: string | undefined;
  }>;
}>;

/**
 * Reads and validates settings from the environment. On failure the error
 * names the offending variables but never echoes their values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): VigilConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => ({
      variable: issue.path.join("."),
      problem: issue.code,
    }));
    const names = [...new Set(problems.map((p) => p.variable))].join(", ");
    throw new ConfigError(`invalid configuration: ${names}`, { problems });
  }
  const v = parsed.data;
  return Object.freeze({
    mode: v.VIGIL_MODE,
    network: v.QORE_NETWORK,
    chainId: v.QORE_CHAIN_ID,
    rpcUrl: v.QORE_RPC_URL,
    restUrl: v.QORE_REST_URL,
    evmRpcUrl: v.QORE_EVM_RPC_URL,
    rollupId: v.ROLLUP_ID,
    dataDir: v.VIGIL_DATA_DIR,
    logLevel: v.LOG_LEVEL,
    http: Object.freeze({
      timeoutMs: v.HTTP_TIMEOUT_MS,
      maxRetries: v.HTTP_MAX_RETRIES,
      requestsPerMinute: v.HTTP_REQUESTS_PER_MINUTE,
    }),
    gasPrice: v.QORE_GAS_PRICE,
    secrets: Object.freeze({
      mnemonic: v.QORE_MNEMONIC,
      pqcSeedHex: v.QORE_PQC_SEED_HEX,
      keystorePassphrase: v.VIGIL_KEYSTORE_PASSPHRASE,
    }),
    alerts: Object.freeze({
      webhookUrl: v.ALERT_WEBHOOK_URL,
      telegramBotToken: v.TELEGRAM_BOT_TOKEN,
      telegramChatId: v.TELEGRAM_CHAT_ID,
    }),
  });
}
