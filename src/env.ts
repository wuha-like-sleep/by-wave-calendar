import "dotenv/config";
import { z } from "zod";

const boolFlag = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((v) => (typeof v === "boolean" ? v : ["true", "1", "yes"].includes(v)));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  // Apple Push Notification Service (optional). When APNS_KEY_ID is
  // blank, all push attempts no-op and the server logs once at boot.
  // Sandbox vs production is auto-selected by APNS_PRODUCTION.
  //   APNS_KEY_PATH = absolute path to the .p8 key file from Apple
  //     Developer Console → Keys → "+" → Apple Push Notifications service
  //   APNS_KEY_ID   = 10-char ID shown next to the key in the console
  //   APNS_TEAM_ID  = 10-char team ID from your Apple Developer membership
  //   APNS_BUNDLE_ID = e.g. cn.bywave.calendar (matches the iOS app)
  APNS_KEY_PATH: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRODUCTION: boolFlag.default(false),

  // Sign in with Apple (#67). Comma-separated list of accepted `aud`
  // values for the Apple identity token. For the native iOS app this is
  // the app's BUNDLE ID (e.g. cn.bywave.calendar); for web SIWA it's the
  // Service ID. List both if you support both. When EMPTY, the server's
  // /api/v1/auth/apple endpoint refuses all requests (feature off) — set
  // this only after configuring "Sign in with Apple" in Apple Developer.
  // Falls back to APNS_BUNDLE_ID if that's set and this isn't.
  SIWA_CLIENT_IDS: z.string().optional(),

  // PG connection pool max. Default 20 covers a typical 1-process pm2
  // deployment: reminders cron + per-request connections + CalDAV burst
  // syncs can otherwise queue behind the prior 10-connection limit and
  // make every endpoint feel slow during peak. Bump to 40+ if you put
  // multiple users on the same calendar via heavy CalDAV / API traffic.
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  REGISTRATION_OPEN: boolFlag.default(true),
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),

  // SSRF guard escape hatch. Outbound fetches of *user-supplied* URLs (ICS
  // subscriptions, one-shot URL imports, and — defense-in-depth — outbound
  // webhooks) are blocked from reaching private / loopback / link-local /
  // reserved IP ranges by default. Self-hosters who legitimately need to
  // pull an ICS feed from an internal host (e.g. an intranet calendar) can
  // set this to true to opt out of the IP-range block. Protocol (http/https
  // only) and embedded-credential checks still apply. Leave false unless you
  // know you need it — this is the SSRF blast-radius control.
  ICS_ALLOW_PRIVATE_NETWORK: boolFlag.default(false),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  // HTTPS direct-listen (no nginx reverse proxy).
  USE_HTTPS: boolFlag.default(false),
  HTTPS_PORT: z.coerce.number().int().positive().default(443),
  HTTP_REDIRECT_PORT: z.coerce.number().int().positive().default(80),
  HTTPS_CERT_PATH: z.string().optional(),
  HTTPS_KEY_PATH: z.string().optional(),

  // SMTP / mailer. Required for register email verification + login alerts.
  // If SMTP_HOST is blank, mailer is disabled and email-dependent features fall back
  // to printing the verification code to the server logs (dev only).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: boolFlag.default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default("ByWave-Calendar"),

  // 中国大陆 ICP 备案号 —— 空就不显示，本项目部署到 lz-ss.com 时填写。
  ICP_NUMBER: z.string().optional(),
  ICP_URL: z.string().default("https://beian.miit.gov.cn/"),

  // 站点名 + 默认 logo URL（管理员上传后会被覆盖）
  SITE_NAME: z.string().default("ByWave-Calendar"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
