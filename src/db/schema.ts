import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  isAdmin: boolean("is_admin").notNull().default(false),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaTotpSecret: text("mfa_totp_secret"),
  // Mid-setup pending secret. Lives only between POST /mfa/setup and
  // POST /mfa/verify; cleared after activation or on disable.
  mfaPendingSecret: text("mfa_pending_secret"),
  mfaBackupCodes: jsonb("mfa_backup_codes"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  themePalette: text("theme_palette"),
  themeDensity: text("theme_density"),
  // Per-user UI language. NULL means "inherit site default". Valid
  // values are entries in src/lib/i18n.ts SUPPORTED_LOCALES (zh-CN, en).
  // The locale resolver falls back to site_settings.default_locale →
  // Accept-Language → "zh-CN" when this is NULL.
  locale: text("locale"),
  // Set on first SSO sign-in (and any subsequent SSO login if previously null).
  // Lets the user-management page show "通过 X 登录"; doesn't restrict other paths.
  ssoProviderSlug: text("sso_provider_slug"),
  // Apple "sub" (stable per-user opaque id) from Sign in with Apple (#67).
  // Set on first SIWA login; used to re-link the same Apple account on
  // subsequent logins even if the user hid their email (Apple private relay
  // can rotate the email but `sub` is stable). Unique so two accounts can't
  // claim the same Apple identity. NULL for non-Apple accounts.
  appleSub: text("apple_sub"),
  // Admin can flip this to suspend an account without deleting it (login is
  // rejected with a friendly "账号已停用" message until the admin re-enables).
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailUnique: uniqueIndex("users_email_unique").on(t.email),
  // Partial unique index: at most one account per Apple `sub`. Postgres
  // treats NULLs as distinct so the many non-Apple accounts (apple_sub
  // NULL) don't collide.
  appleSubUnique: uniqueIndex("users_apple_sub_unique").on(t.appleSub),
}));

export const passwordResets = pgTable("password_resets", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("password_resets_user_idx").on(t.userId),
}));

export const emailVerifications = pgTable("email_verifications", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const siteSettings = pgTable("site_settings", {
  // Singleton row pinned to id = 1.
  id: integer("id").primaryKey().default(1),
  siteName: text("site_name").notNull().default("ByWave-Calendar"),
  logoUrl: text("logo_url"),
  registrationMode: text("registration_mode").notNull().default("public"),
  icpNumber: text("icp_number"),
  icpUrl: text("icp_url").default("https://beian.miit.gov.cn/"),
  ssoKeycloakEnabled: boolean("sso_keycloak_enabled").notNull().default(false),
  ssoKeycloakIssuerUrl: text("sso_keycloak_issuer_url"),
  ssoKeycloakClientId: text("sso_keycloak_client_id"),
  ssoKeycloakClientSecret: text("sso_keycloak_client_secret"),
  ssoKeycloakLabel: text("sso_keycloak_label").default("使用 SSO 登录"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port").default(465),
  smtpSecure: boolean("smtp_secure").notNull().default(true),
  smtpUser: text("smtp_user"),
  smtpPass: text("smtp_pass"),
  mailFromAddress: text("mail_from_address"),
  mailFromName: text("mail_from_name").default("ByWave-Calendar"),
  themePalette: text("theme_palette").notNull().default("indigo"),
  themeDensity: text("theme_density").notNull().default("comfortable"),
  // Security knobs surfaced on /admin/security
  riskLoginEnabled: boolean("risk_login_enabled").notNull().default(true),
  lockoutEnabled: boolean("lockout_enabled").notNull().default(true),
  lockoutThreshold: integer("lockout_threshold").notNull().default(5),
  lockoutMinutes: integer("lockout_minutes").notNull().default(15),
  // Human-verification (CAPTCHA) on public registration. provider:
  //   "none" | "builtin" (self-hosted PoW) | "turnstile" | "recaptcha" | …
  // siteKey is the public key (safe to render); secret is the private key.
  captchaProvider: text("captcha_provider").notNull().default("builtin"),
  captchaSiteKey: text("captcha_site_key"),
  captchaSecret: text("captcha_secret"),
  // Builtin PoW UX mode: "invisible" (auto-solve, no click) | "interactive"
  // (click-to-verify). Server-side verification is identical for both.
  captchaBuiltinMode: text("captcha_builtin_mode").notNull().default("invisible"),
  // Email branding (admin-editable in /admin/email-templates). brandColor is the
  // primary accent used in every email header/button/link; footerNote is the
  // tagline after the copyright line. Both fall back to indigo / 日历共享平台.
  emailBrandColor: text("email_brand_color").notNull().default("#4f46e5"),
  emailFooterNote: text("email_footer_note").notNull().default("日历共享平台"),
  // BIMI (Brand Indicators for Message Identification): the SVG shown as the
  // sender avatar in supporting inboxes. bimiSvgUrl points at the admin-uploaded
  // SVG (served from /static/uploads/bimi.svg); null = use the bundled default at
  // /static/bimi/logo.svg. bimiVmcUrl is the optional VMC/CMC certificate URL
  // (required by Gmail/Apple to actually render the logo).
  bimiSvgUrl: text("bimi_svg_url"),
  bimiVmcUrl: text("bimi_vmc_url"),
  // External IdP (Keycloak) as an API auth source — ByWave acts as an OAuth
  // resource server. When on, /api/v1 accepts access tokens issued by an
  // enabled SSO provider (validated via its JWKS). A token authenticated by
  // an ordinary user client can ONLY act as that user's own account; only
  // client IDs listed in idpApiServiceClients (a trusted server-to-server
  // integration, e.g. the meeting platform) may pass an X-Account header to
  // act on behalf of any account. autoProvision creates a missing account on
  // first service-token access (for bulk "开通").
  idpApiEnabled: boolean("idp_api_enabled").notNull().default(false),
  idpApiServiceClients: text("idp_api_service_clients").notNull().default(""),
  idpApiAutoProvision: boolean("idp_api_auto_provision").notNull().default(false),
  // Master switch for the third-party API: when off, /api/* rejects Bearer
  // tokens (session-cookie calls from the in-app JS still work fine).
  apiEnabled: boolean("api_enabled").notNull().default(false),
  // Master switch for the native iOS / Android / desktop APP feature.
  // When off:
  //   - /api/v1/devices/pair-init / pair-claim / auth/refresh all 403
  //   - Bearer JWT auth path rejects (paired apps lose access)
  //   - /app/settings#devices hides the "绑定新设备" button + shows notice
  // Default ON because most self-hosted admins want it; turn off if you
  // don't want any non-web clients touching your server.
  appsEnabled: boolean("apps_enabled").notNull().default(true),
  // Master switch for the web 扫码登录 (QR scan-login) feature. When off:
  //   - The /login page hides the「扫码登录」tab entirely (server-side
  //     render check, not just CSS — so unauthenticated users can't even
  //     poke at the endpoint).
  //   - POST /api/v1/devices/web-pair-init returns 403.
  //   - GET /api/v1/devices/web-pair-status returns 403.
  //   - POST /api/v1/devices/web-pair-approve from phone APPs also 403s.
  // Independent of `appsEnabled` because some admins might want the APPs
  // working (CalDAV-style sync) but distrust the QR cross-device login
  // flow (or just don't want to surface it on the login page). Default ON.
  qrLoginEnabled: boolean("qr_login_enabled").notNull().default(true),
  // Default UI language for unauthenticated visitors and users who
  // haven't explicitly chosen one. "auto" means resolve from the
  // browser Accept-Language header; any other value must be a key
  // in SUPPORTED_LOCALES (zh-CN, en). Set during install + editable
  // in /admin/site → 网站语言.
  defaultLocale: text("default_locale").notNull().default("zh-CN"),
  // When true, admin accounts MUST have MFA enabled — login is gated on the
  // /app/settings/mfa/setup flow until they do.
  forceAdminMfa: boolean("force_admin_mfa").notNull().default(false),
  // When false, /embed/<token> returns 404 site-wide. Admin can flip this
  // off if they don't want third-party sites embedding the calendar iframe.
  // Doesn't affect the underlying ICS share — those still work via /ics/.
  embedEnabled: boolean("embed_enabled").notNull().default(true),
  // VAPID key pair for Web Push. Generated lazily on first /admin/push
  // visit; persisted so push subscriptions stay valid across restarts.
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKey: text("vapid_private_key"),
  // VAPID requires a "subject" — typically mailto:admin@... — for the
  // push services to contact you if your pushes misbehave.
  vapidSubject: text("vapid_subject"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- OAuth 2.0 authorization server tables ----
// We act as the IdP for third-party apps. Admin registers an app here;
// users grant consent at /oauth/authorize; we exchange an auth code
// for an access token at /oauth/token. The token then auths the app
// against /api/v1/* via Authorization: Bearer ...
//
// Distinguished from api_tokens (which are admin-issued, no user
// consent step): oauth_access_tokens are user-granted via a consent
// screen, can be revoked by the user from /app/settings.
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Public-facing identifier (shown to user on consent screen). Use a
  // human-friendly random string like "bwc_app_a4f9". Not secret.
  clientId: text("client_id").notNull(),
  // Hashed (bcrypt). Plain shown once to admin at creation; never again.
  clientSecretHash: text("client_secret_hash").notNull(),
  // Display info for the consent screen.
  name: text("name").notNull(),
  description: text("description"),
  logoUrl: text("logo_url"),
  // Newline-separated allowed redirect URIs. Strict equality match.
  redirectUris: text("redirect_uris").notNull(),
  // JSON array of scope strings. Empty array = read-only profile.
  allowedScopes: jsonb("allowed_scopes").notNull().default(["read:events"]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  clientIdUnique: uniqueIndex("oauth_clients_client_id_unique").on(t.clientId),
}));

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  code: text("code").primaryKey(),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // PKCE challenge (S256 only — we don't accept plain). Stored verbatim;
  // verified at /oauth/token by hashing the supplied verifier.
  codeChallenge: text("code_challenge"),
  redirectUri: text("redirect_uri").notNull(),
  scopes: jsonb("scopes").notNull(),
  // Codes are one-time-use AND short-lived (10 min). Token exchange
  // deletes the row to enforce single-use.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAccessTokens = pgTable("oauth_access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  // bcrypt hash of the full token; prefix kept plain for lookups.
  tokenHash: text("token_hash").notNull(),
  prefix: text("prefix").notNull(),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scopes: jsonb("scopes").notNull(),
  // 30-day default. User can revoke from /app/settings#oauth.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  prefixIdx: index("oauth_access_tokens_prefix_idx").on(t.prefix),
  userIdx: index("oauth_access_tokens_user_idx").on(t.userId),
}));

// Per-user Web Push subscriptions. One row per (user, device/browser);
// the same user on phone + laptop gets two rows. Delete on push failure
// with statusCode 410 (gone) — browser revoked the subscription.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => ({
  userIdx: index("push_subscriptions_user_idx").on(t.userId),
  endpointUnique: uniqueIndex("push_subscriptions_endpoint_unique").on(t.endpoint),
}));

export const loginAlerts = pgTable("login_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ipHash: text("ip_hash").notNull(),
  uaHash: text("ua_hash").notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("login_alerts_user_idx").on(t.userId),
  uniq: uniqueIndex("login_alerts_user_ip_ua_unique").on(t.userId, t.ipHash, t.uaHash),
}));

// NOTE: events.exdates is added in migration 0030. See drizzle/migrations.
// We expose it on the type below so handlers can read/write it.

// Append-only audit trail for admin-level actions (token issuance, backup
// restore, SSO provider create/edit, update-apply, etc.). Surfaces in
// /admin/audit so multiple admins can see who did what when.
export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // SET NULL (not CASCADE) so a self-deleting admin doesn't take their
  // own audit trail with them — we still want to know what actions they
  // took, even after the account is gone.
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),  // e.g. "api_token.create", "backup.restore"
  targetType: text("target_type"),   // "api_token", "sso_provider", "user", etc.
  targetId: text("target_id"),
  details: jsonb("details"),         // free-form snapshot of relevant fields
  ip: text("ip").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actorIdx: index("admin_audit_actor_idx").on(t.actorUserId),
  createdIdx: index("admin_audit_created_idx").on(t.createdAt),
}));

export const loginChallenges = pgTable("login_challenges", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  ipHash: text("ip_hash").notNull(),
  uaHash: text("ua_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("login_challenges_user_idx").on(t.userId),
}));

export const loginEvents = pgTable("login_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  method: text("method").notNull(),
  ip: text("ip").notNull(),
  userAgent: text("user_agent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("login_events_user_idx").on(t.userId),
  createdIdx: index("login_events_created_idx").on(t.createdAt),
}));

export const ssoProviders = pgTable("sso_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  enabled: boolean("enabled").notNull().default(true),
  // Reserved for future kinds: "oidc" today; could add "saml", "ldap" later.
  providerKind: text("provider_kind").notNull().default("oidc"),
  // Used as a stable URL slug too — e.g. /auth/sso/<slug>/login. Lowercase, unique.
  slug: text("slug").notNull(),
  issuerUrl: text("issuer_url").notNull(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  label: text("label").notNull().default("SSO 登录"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUnique: uniqueIndex("sso_providers_slug_unique").on(t.slug),
}));

// Linked external login identities (one person ⇒ one ByWave account with
// possibly several ways to sign in). A user who has both an SSO login and a
// personal email/password account can bind them so any login method lands on
// the same account. SSO callback resolves by (provider, subject) first, then
// falls back to email. `subject` is the IdP's stable `sub` claim.
export const userIdentities = pgTable("user_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),   // sso_providers.slug
  subject: text("subject").notNull(),      // IdP `sub`
  email: text("email"),                    // email seen at link time (informational)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  providerSubjectUnique: uniqueIndex("user_identities_provider_subject_unique").on(t.provider, t.subject),
  userIdx: index("user_identities_user_idx").on(t.userId),
}));

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mfaSatisfied: boolean("mfa_satisfied").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("sessions_user_idx").on(t.userId),
}));

export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports").array(),
  deviceName: text("device_name"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  credIdUnique: uniqueIndex("webauthn_credentials_credential_id_unique").on(t.credentialId),
  userIdx: index("webauthn_credentials_user_idx").on(t.userId),
}));

export const appPasswords = pgTable("app_passwords", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  scope: text("scope").notNull().default("caldav"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("app_passwords_user_idx").on(t.userId),
  prefixIdx: index("app_passwords_prefix_idx").on(t.prefix),
}));

// Long-lived bearer tokens for third-party integrations (n8n / Zapier / Zoom /
// Notion / cron / internal services). Each token acts on behalf of `userId` —
// same authority as that user logging in via the browser, scoped to their own
// calendars. Users create + manage their own from /app/settings; admin can
// kill switch the whole feature via site_settings.apiEnabled.
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  // "read" → GET only, "write" → all methods. Default write = ergonomic for n8n.
  scope: text("scope").notNull().default("write"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: text("last_used_ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("api_tokens_user_idx").on(t.userId),
  prefixIdx: index("api_tokens_prefix_idx").on(t.prefix),
}));

// Native app / desktop client registrations. Each row represents one
// installed app instance bound to a user. Refresh tokens are long-lived
// (years) and traded for short-lived JWT access tokens via /api/v1/auth/refresh.
// Distinct from `apiTokens` (which are admin-issued for n8n / Zapier).
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),                // "iPhone 15 Pro" or self-described
  kind: text("kind").notNull().default("other"), // ios / android / desktop / other
  refreshTokenHash: text("refresh_token_hash").notNull(),  // bcrypt of full token
  refreshTokenPrefix: text("refresh_token_prefix").notNull(),  // bwd_XXXXXXXX_ — for index lookup
  appVersion: text("app_version"),
  pushToken: text("push_token"),                 // APNs / FCM token (set later)
  // Stable per-install UUID generated by the APP and persisted in iCloud
  // Keychain (survives uninstall + reinstall on the same Apple ID). When
  // the same physical device signs out then in again we look this up
  // FIRST and update the existing row instead of inserting a new one —
  // so the user's "my devices" page doesn't grow a duplicate every time
  // they tap "只退出登录" → 再登录。Null on legacy rows / non-app clients.
  clientDeviceId: text("client_device_id"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastSeenIp: text("last_seen_ip"),
  firstSeenIp: text("first_seen_ip"),
  firstUserAgent: text("first_user_agent"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("devices_user_idx").on(t.userId),
  prefixIdx: index("devices_prefix_idx").on(t.refreshTokenPrefix),
}));

// Pairing codes — short-lived (5 min) one-time codes generated when the user
// clicks "Pair new device" on the web. The QR encodes (serverUrl, code);
// the app posts the code back to /api/v1/devices/pair-claim to receive
// refresh + access tokens. Pairing codes are 6-char human-readable in
// case the user has to type them manually.
export const devicePairings = pgTable("device_pairings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),       // 6 alphanumeric, displayed in QR
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedDeviceId: uuid("claimed_device_id"),  // null until claimed
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: index("device_pairings_code_idx").on(t.code),
  expiresIdx: index("device_pairings_expires_idx").on(t.expiresAt),
}));

export const calendars = pgTable("calendars", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#3b82f6"),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerIdx: index("calendars_owner_idx").on(t.ownerId),
}));

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  uid: text("uid").notNull(),
  summary: text("summary").notNull(),
  description: text("description"),
  location: text("location"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  allDay: boolean("all_day").notNull().default(false),
  rrule: text("rrule"),
  // Per-instance exclusions for a recurring master. When the user deletes
  // "just this occurrence" (or detaches it via edit-仅此次), we append
  // the original instance start (ISO) to this array. rrule_expand reads
  // it and skips matching occurrences. Null for non-recurring events.
  exdates: jsonb("exdates"),
  extra: jsonb("extra"),
  rawIcs: text("raw_ics"),
  // Soft-delete column. Set instead of removing the row so invitation tokens
  // can still resolve the event and render a "已取消" notice to recipients,
  // and so we can fire CANCEL .ics emails after the user removes the event.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("events_calendar_idx").on(t.calendarId),
  uidUnique: uniqueIndex("events_calendar_uid_unique").on(t.calendarId, t.uid),
  startsIdx: index("events_starts_idx").on(t.startsAt),
  // Composite — CalDAV REPORT + /api/events filter both calendarId AND
  // deletedAt IS NULL on every request. The single-column calIdx forces
  // a heap re-scan for deleted_at; the composite resolves the predicate
  // entirely from the index.
  calDeletedIdx: index("events_cal_deleted_idx").on(t.calendarId, t.deletedAt),
  // Reminders cron runs every minute and scans all rows where rrule IS NOT NULL.
  // PARTIAL index (WHERE rrule IS NOT NULL) so it only holds recurring masters —
  // the vast majority of rows are non-recurring and don't belong in it.
  rruleIdx: index("events_rrule_idx").on(t.rrule).where(sql`${t.rrule} IS NOT NULL`),
  // Soft-delete purge cron queries deleted_at < cutoff. PARTIAL index
  // (WHERE deleted_at IS NOT NULL) keeps it tiny — almost every row is live.
  deletedAtIdx: index("events_deleted_at_idx").on(t.deletedAt).where(sql`${t.deletedAt} IS NOT NULL`),
}));

export const calendarMembers = pgTable("calendar_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("viewer"),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("calendar_members_cal_idx").on(t.calendarId),
  userIdx: index("calendar_members_user_idx").on(t.userId),
  uniq: uniqueIndex("calendar_members_cal_user_unique").on(t.calendarId, t.userId),
}));

// Append-only log of which alarms we've already dispatched (one row per
// (event, trigger) pair). The reminder scheduler queries this to skip
// already-sent reminders even after a server restart.
export const remindersSent = pgTable("reminders_sent", {
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(),           // e.g. "-PT15M"
  // For recurring events we need per-occurrence idempotency. Otherwise the
  // first occurrence of a weekly meeting fires a reminder, inserts a row
  // keyed by (event_id, trigger), and every subsequent week is silently
  // skipped because the row already exists. instance_start is the UTC
  // start of THIS occurrence (== events.startsAt for non-recurring).
  instanceStart: timestamp("instance_start", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex("reminders_sent_event_trigger_instance_unique").on(t.eventId, t.trigger, t.instanceStart),
}));

export const eventInviteTokens = pgTable("event_invite_tokens", {
  token: text("token").primaryKey(),
  sourceEventId: uuid("source_event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  recipientEmail: text("recipient_email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  // RSVP — independent of acceptedAt (which means "added to my ByWave calendar").
  // Values: "pending" (default), "accepted", "declined", "tentative".
  responseStatus: text("response_status").notNull().default("pending"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  evIdx: index("event_invite_tokens_event_idx").on(t.sourceEventId),
  emailIdx: index("event_invite_tokens_email_idx").on(t.recipientEmail),
}));

// User-registration invites — used when site_settings.registration_mode =
// "invite". An admin generates a token; the invitee registers via
// /register?invite=<token>. Single-use by default (max_uses = 1); `email`
// optionally scopes it to one address. Consumed on successful email verify.
export const signupInvites = pgTable("signup_invites", {
  token: text("token").primaryKey(),
  email: text("email"),                 // NULL = anyone with the link
  note: text("note"),                   // admin's free-text label
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calendarInvitations = pgTable("calendar_invitations", {
  token: text("token").primaryKey(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("viewer"),
  // SET NULL (not CASCADE) so deleting the inviter doesn't yank back
  // every pending invitation they sent — invitees can still accept and
  // get access, the invitedBy just becomes anonymous.
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  message: text("message"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("calendar_invitations_cal_idx").on(t.calendarId),
  emailIdx: index("calendar_invitations_email_idx").on(t.email),
}));

export const calendarSubscriptions = pgTable("calendar_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  label: text("label"),
  refreshMinutes: integer("refresh_minutes").notNull().default(360),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  lastEventCount: integer("last_event_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("calendar_subscriptions_cal_idx").on(t.calendarId),
}));

// Calendly-style booking pages. Each user can create N booking links;
// visitors at /book/<userId>/<slug> see available slots and submit a name
// + email + optional message → event created in the owner's chosen calendar.
export const bookingLinks = pgTable("booking_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  // weeklyAvailability: { "1": [["09:00","12:00"],["13:00","18:00"]], "2": [...], "0": null }
  // Keys are weekday numbers (0=Sun ~ 6=Sat), values are HH:MM time ranges
  // or null for fully-unavailable days.
  weeklyAvailability: jsonb("weekly_availability").notNull(),
  minNoticeHours: integer("min_notice_hours").notNull().default(2),
  maxDaysAhead: integer("max_days_ahead").notNull().default(14),
  bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
  bufferAfterMin: integer("buffer_after_min").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  // Whether the link owner gets an email each time someone books a slot.
  // Default true preserves the v1.3.9-and-prior behavior for all existing
  // links. Owners can toggle this on the booking-links admin page after
  // creation, or set it explicitly at create time.
  // (The guest's own confirmation email is unrelated — that one always
  // sends because the guest needs the cancel link.)
  notifyEmail: boolean("notify_email").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userSlugUnique: uniqueIndex("booking_links_user_slug_unique").on(t.userId, t.slug),
  userIdx: index("booking_links_user_idx").on(t.userId),
}));

export const bookings = pgTable("bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  linkId: uuid("link_id").notNull().references(() => bookingLinks.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
  guestEmail: text("guest_email").notNull(),
  guestName: text("guest_name").notNull(),
  guestMessage: text("guest_message"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  cancelToken: text("cancel_token").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  linkIdx: index("bookings_link_idx").on(t.linkId),
  cancelTokenUnique: uniqueIndex("bookings_cancel_token_unique").on(t.cancelToken),
}));

export const shareTokens = pgTable("share_tokens", {
  token: text("token").primaryKey(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  label: text("label"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("share_tokens_calendar_idx").on(t.calendarId),
}));

// Admin-configured outbound webhooks. On event create/update/delete we
// POST a small JSON payload to every enabled webhook URL. Useful for
// piping into Zapier / n8n / internal services without having to
// poll our API.
export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Free-text label for the admin UI ("Notion duty roster", "Slack #ops").
  label: text("label").notNull(),
  url: text("url").notNull(),
  // Bitmask of subscribed events: event.created / event.updated /
  // event.deleted / booking.created / booking.cancelled. Stored as a
  // JSON array of strings so adding more in the future doesn't need
  // a migration.
  events: jsonb("events").notNull().default(["event.created", "event.updated", "event.deleted"]),
  // Optional HMAC-SHA256 shared secret. If set, the outbound request
  // carries an X-Bywave-Signature header so the receiver can verify
  // it came from us.
  secret: text("secret"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only delivery log. Lets the admin see "did Notion receive that
// last event create?" without grepping pm2 logs.
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  eventName: text("event_name").notNull(),
  // We snapshot the payload so the admin can resend or debug.
  payload: jsonb("payload"),
  // HTTP response. statusCode = null when the request failed before
  // even getting a response (DNS / TCP / TLS).
  statusCode: integer("status_code"),
  responseBody: text("response_body"),  // truncated to 1KB
  attemptCount: integer("attempt_count").notNull().default(1),
  ok: boolean("ok").notNull().default(false),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  webhookIdx: index("webhook_deliveries_webhook_idx").on(t.webhookId),
  createdIdx: index("webhook_deliveries_created_idx").on(t.createdAt),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Calendar = typeof calendars.$inferSelect;
export type NewCalendar = typeof calendars.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type ShareToken = typeof shareTokens.$inferSelect;
export type NewShareToken = typeof shareTokens.$inferInsert;
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type LoginAlert = typeof loginAlerts.$inferSelect;
export type SiteSettings = typeof siteSettings.$inferSelect;
export type CalendarMember = typeof calendarMembers.$inferSelect;
export type CalendarInvitation = typeof calendarInvitations.$inferSelect;
export type AppPassword = typeof appPasswords.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DevicePairing = typeof devicePairings.$inferSelect;
export type NewAppPassword = typeof appPasswords.$inferInsert;
export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type NewCalendarSubscription = typeof calendarSubscriptions.$inferInsert;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type OAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type OAuthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type LoginEvent = typeof loginEvents.$inferSelect;
export type NewLoginEvent = typeof loginEvents.$inferInsert;
export type SsoProvider = typeof ssoProviders.$inferSelect;
export type NewSsoProvider = typeof ssoProviders.$inferInsert;
export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;
export type BookingLink = typeof bookingLinks.$inferSelect;
export type NewBookingLink = typeof bookingLinks.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type SignupInvite = typeof signupInvites.$inferSelect;
export type NewSignupInvite = typeof signupInvites.$inferInsert;
