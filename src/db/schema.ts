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

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  isAdmin: boolean("is_admin").notNull().default(false),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaTotpSecret: text("mfa_totp_secret"),
  mfaBackupCodes: jsonb("mfa_backup_codes"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  themePalette: text("theme_palette"),
  themeDensity: text("theme_density"),
  // Set on first SSO sign-in (and any subsequent SSO login if previously null).
  // Lets the user-management page show "通过 X 登录"; doesn't restrict other paths.
  ssoProviderSlug: text("sso_provider_slug"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailUnique: uniqueIndex("users_email_unique").on(t.email),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  extra: jsonb("extra"),
  rawIcs: text("raw_ics"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("events_calendar_idx").on(t.calendarId),
  uidUnique: uniqueIndex("events_calendar_uid_unique").on(t.calendarId, t.uid),
  startsIdx: index("events_starts_idx").on(t.startsAt),
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

export const eventInviteTokens = pgTable("event_invite_tokens", {
  token: text("token").primaryKey(),
  sourceEventId: uuid("source_event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  recipientEmail: text("recipient_email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  evIdx: index("event_invite_tokens_event_idx").on(t.sourceEventId),
  emailIdx: index("event_invite_tokens_email_idx").on(t.recipientEmail),
}));

export const calendarInvitations = pgTable("calendar_invitations", {
  token: text("token").primaryKey(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("viewer"),
  invitedBy: uuid("invited_by").notNull().references(() => users.id, { onDelete: "cascade" }),
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

export const shareTokens = pgTable("share_tokens", {
  token: text("token").primaryKey(),
  calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  label: text("label"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  calIdx: index("share_tokens_calendar_idx").on(t.calendarId),
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
export type NewAppPassword = typeof appPasswords.$inferInsert;
export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type NewCalendarSubscription = typeof calendarSubscriptions.$inferInsert;
export type LoginEvent = typeof loginEvents.$inferSelect;
export type NewLoginEvent = typeof loginEvents.$inferInsert;
export type SsoProvider = typeof ssoProviders.$inferSelect;
export type NewSsoProvider = typeof ssoProviders.$inferInsert;
