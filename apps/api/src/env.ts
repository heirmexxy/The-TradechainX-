import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  PUBLIC_API_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),

  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  OTP_PEPPER: z.string().min(16),

  CHAIN_ID: z.coerce.number().int(),
  RPC_URL: z.string().url(),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(3),
  INDEXER_POLL_MS: z.coerce.number().int().min(250).default(4000),
  INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(10).default(2000),

  EMAIL_PROVIDER: z.enum(["console", "sendgrid"]).default("console"),
  EMAIL_FROM: z.string().email().default("no-reply@tradechainx.com"),
  SENDGRID_API_KEY: z.string().optional(),

  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().default("./storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),

  // S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO). Endpoint + keys for non-AWS.
  S3_ENDPOINT: z.string().url().optional().or(z.literal("")),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  // Embedded-wallet login tokens (see src/auth/walletToken.ts). PKCS8 PEM; "\n" escapes allowed.
  WALLET_PROVIDER: z.enum(["dev", "privy", "dynamic", "sequence"]).default("dev"),
  WALLET_TOKEN_PRIVATE_KEY: z.string().optional(),
  WALLET_TOKEN_KID: z.string().optional(),
  WALLET_TOKEN_AUDIENCE: z.string().optional(),

  // Gas station (interim, until wallet-provider gas sponsorship is on).
  GAS_STATION_ENABLED: bool,
  GAS_STATION_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().or(z.literal("")),
  GAS_STATION_TOP_UP: z.string().default("0.2"),
  GAS_STATION_MIN_BALANCE: z.string().default("0.05"),
  GAS_STATION_COOLDOWN_HOURS: z.coerce.number().min(1).default(24),

  // Fiat on/off-ramp (see src/ramps). "none" hides deposit/withdraw.
  RAMP_PROVIDER: z.enum(["none", "oms", "partner"]).default("none"),
  RAMP_API_URL: z.string().url().optional().or(z.literal("")),
  RAMP_API_KEY: z.string().optional(),
  RAMP_WEBHOOK_SECRET: z.string().optional(),
  RAMP_CURRENCIES: z.string().optional(), // e.g. "NGN,KES"
  RAMP_COUNTRIES: z.string().optional(), // e.g. "NG,KE"

  // Partner API. The pepper derives webhook signing secrets (never stored); 32+ random chars.
  PARTNER_API_ENABLED: bool,
  // Distribution API (fintech naira orders). Sandbox wallets are fake addresses for integration testing only.
  DISTRIBUTION_API_ENABLED: bool,
  DISTRIBUTION_SANDBOX_WALLETS: bool,
  WEBHOOK_SECRET_PEPPER: z.string().optional(),
  // Public site origin used in widget links (defaults to WEB_ORIGIN).
  PUBLIC_WEB_URL: z.string().url().optional().or(z.literal("")),

  // System health monitor + alerts.
  HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
  INDEXER_MAX_LAG_BLOCKS: z.coerce.number().int().min(1).default(50),
  ALERT_EMAILS: z.string().optional(), // comma-separated
  ALERT_SLACK_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  ALERT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
  // JSON array of {"name","url","kind":"statuspage"|"http"} to add or override supplier status checks.
  STATUS_PAGES: z.string().optional(),

  DEV_TOOLS: bool,
  DEV_SHOW_OTP: bool,
  DEV_FAUCET_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().or(z.literal("")),
  DEV_WALLET_SEED: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === "production") {
    const devFlags = [
      env.DEV_TOOLS && "DEV_TOOLS",
      env.DEV_SHOW_OTP && "DEV_SHOW_OTP",
      env.DEV_FAUCET_KEY && "DEV_FAUCET_KEY",
      env.EMAIL_PROVIDER === "console" && "EMAIL_PROVIDER=console",
    ].filter(Boolean);
    if (devFlags.length) {
      throw new Error(`Refusing to start in production with development settings: ${devFlags.join(", ")}`);
    }
    if (env.STORAGE_PROVIDER === "local") {
      throw new Error("Use STORAGE_PROVIDER=s3 in production; local disk storage is for development.");
    }
  }
  if (env.EMAIL_PROVIDER === "sendgrid" && !env.SENDGRID_API_KEY) {
    throw new Error("EMAIL_PROVIDER=sendgrid needs SENDGRID_API_KEY");
  }
  if (env.STORAGE_PROVIDER === "s3" && (!env.S3_BUCKET || !env.S3_REGION)) {
    throw new Error("STORAGE_PROVIDER=s3 needs S3_BUCKET and S3_REGION (use \"auto\" for Cloudflare R2)");
  }
  if (env.NODE_ENV === "production") {
    if (env.WALLET_PROVIDER === "dev") throw new Error("WALLET_PROVIDER=dev isn't allowed in production");
    if (!env.WALLET_TOKEN_PRIVATE_KEY) throw new Error("WALLET_TOKEN_PRIVATE_KEY is required in production");
  }
  if (env.NODE_ENV === "production" && env.DISTRIBUTION_SANDBOX_WALLETS) {
    throw new Error("DISTRIBUTION_SANDBOX_WALLETS must be false in production (it creates addresses nobody controls)");
  }
  if (env.PARTNER_API_ENABLED && (!env.WEBHOOK_SECRET_PEPPER || env.WEBHOOK_SECRET_PEPPER.length < 32)) {
    throw new Error("PARTNER_API_ENABLED needs WEBHOOK_SECRET_PEPPER (32+ random characters)");
  }
  if (env.GAS_STATION_ENABLED && !env.GAS_STATION_KEY) throw new Error("GAS_STATION_ENABLED needs GAS_STATION_KEY");
  return env;
}

export const env = loadEnv();
