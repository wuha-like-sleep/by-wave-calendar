// Business logic for the device pairing flow. Routes delegate to these
// functions; the routes file stays Fastify-shaped only.

import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import {
  extractRefreshTokenPrefix,
  generatePairingCode,
  issueRefreshToken,
  signAccessToken,
  verifyRefreshToken,
} from "./device_tokens.js";
import { userIsActive } from "./user_state.js";

const PAIRING_TTL_MS = 5 * 60 * 1000;  // 5 minutes

export type PairingInitResult = {
  code: string;
  expiresAt: Date;
};

// Step 1: user is logged in on web, clicks "pair new device". We mint a
// short-lived code; the web page renders a QR encoding {serverUrl, code}
// for the phone to scan.
export async function initPairing(userId: string): Promise<PairingInitResult> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.insert(schema.devicePairings).values({ userId, code, expiresAt });
  return { code, expiresAt };
}

export type ClaimedPairing = {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  deviceId: string;
  userId: string;
  // Email + display name are useful for the APP to render "signed in as
  // alice@…" right after pairing, without an extra /users/me round-trip.
  // They're already loaded for the active-user check below, so passing
  // them up is free.
  userEmail: string;
  userName: string | null;
};

// Step 2: phone POSTs the code → we mark it claimed, create a `devices`
// row with a fresh refresh token, and return both tokens. The pairing
// row stays (audit), but is unusable for further claims (claimed_at set).
//
// If `clientDeviceId` is provided AND a non-revoked row already exists
// for (userId, clientDeviceId), we UPDATE that row in place instead of
// inserting a new one. This is how "退出登录 → 重新登录" stops creating
// duplicate devices entries: the iOS APP keeps the stable UUID in iCloud
// Keychain even after the user clears its refresh token locally.
export async function claimPairing(input: {
  code: string;
  label: string;
  kind: string;
  appVersion?: string | null;
  clientDeviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ClaimedPairing | null> {
  const [pair] = await db
    .select()
    .from(schema.devicePairings)
    .where(eq(schema.devicePairings.code, input.code))
    .limit(1);
  if (!pair) return null;
  if (pair.claimedAt) return null;            // already used
  if (pair.expiresAt < new Date()) return null;  // expired

  // Confirm the user is still active before we hand out a refresh token.
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, pair.userId)).limit(1);
  if (!u || !userIsActive(u)) return null;

  const refresh = await issueRefreshToken();
  const device = await upsertDeviceForUser({
    userId: pair.userId,
    label: input.label,
    kind: input.kind,
    appVersion: input.appVersion ?? null,
    clientDeviceId: input.clientDeviceId ?? null,
    refreshHash: refresh.hash,
    refreshPrefix: refresh.prefix,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  if (!device) return null;
  await db
    .update(schema.devicePairings)
    .set({ claimedDeviceId: device.id, claimedAt: new Date() })
    .where(eq(schema.devicePairings.id, pair.id));

  const access = signAccessToken(pair.userId, device.id);
  return {
    refreshToken: refresh.plain,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    deviceId: device.id,
    userId: pair.userId,
    userEmail: u.email,
    userName: u.displayName,
  };
}

// Shared helper: insert or update the device row for this login attempt.
// When `clientDeviceId` is provided and a live row already exists for
// (userId, clientDeviceId), we update its tokens / metadata in place and
// reuse the same id. Push tokens and last_seen survive the cycle.
// Returns the resulting devices row (whether reused or freshly inserted).
export async function upsertDeviceForUser(input: {
  userId: string;
  label: string;
  kind: string;
  appVersion: string | null;
  clientDeviceId: string | null;
  refreshHash: string;
  refreshPrefix: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<schema.Device | null> {
  if (input.clientDeviceId) {
    const [existing] = await db
      .select()
      .from(schema.devices)
      .where(and(
        eq(schema.devices.userId, input.userId),
        eq(schema.devices.clientDeviceId, input.clientDeviceId),
        isNull(schema.devices.revokedAt),
      ))
      .limit(1);
    if (existing) {
      const [updated] = await db
        .update(schema.devices)
        .set({
          // Refresh token rotates every login (old one becomes unusable
          // because it's hashed and the hash is replaced).
          refreshTokenHash: input.refreshHash,
          refreshTokenPrefix: input.refreshPrefix,
          // Label might change if user renamed their phone.
          label: input.label.trim() || existing.label,
          kind: input.kind || existing.kind,
          appVersion: input.appVersion ?? existing.appVersion,
          lastSeenAt: new Date(),
          lastSeenIp: input.ip ?? existing.lastSeenIp,
          // Keep first_seen_* historical — they describe the original bind.
        })
        .where(eq(schema.devices.id, existing.id))
        .returning();
      return updated ?? existing;
    }
  }
  const [device] = await db.insert(schema.devices).values({
    userId: input.userId,
    label: input.label.trim() || "未命名设备",
    kind: input.kind || "other",
    refreshTokenHash: input.refreshHash,
    refreshTokenPrefix: input.refreshPrefix,
    appVersion: input.appVersion,
    clientDeviceId: input.clientDeviceId,
    firstSeenIp: input.ip,
    firstUserAgent: input.userAgent,
    lastSeenAt: new Date(),
    lastSeenIp: input.ip,
  }).returning();
  return device ?? null;
}

// Exchange refresh → access. Called by the app whenever its cached
// access token is within 5 minutes of expiry (or after 401). Touches
// last_seen_at so the user's "my devices" page is informative.
export async function refreshAccessToken(input: {
  refreshToken: string;
  ip?: string | null;
}): Promise<{ accessToken: string; expiresAt: Date; userId: string; deviceId: string } | null> {
  const prefix = extractRefreshTokenPrefix(input.refreshToken);
  if (!prefix) return null;
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.refreshTokenPrefix, prefix), isNull(schema.devices.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (!(await verifyRefreshToken(input.refreshToken, row.refreshTokenHash))) return null;

  // Disabled-account gate (same as session / api_token paths).
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!userIsActive(u)) return null;

  // Touch last-seen (fire-and-forget for latency).
  void db.update(schema.devices)
    .set({ lastSeenAt: new Date(), lastSeenIp: input.ip ?? row.lastSeenIp })
    .where(eq(schema.devices.id, row.id))
    .catch(() => undefined);

  const access = signAccessToken(row.userId, row.id);
  return { accessToken: access.token, expiresAt: access.expiresAt, userId: row.userId, deviceId: row.id };
}

// Resolve a refresh token directly to its device row — used by the
// access-token middleware to enforce per-device revocation (a JWT can
// still be valid by signature/expiry but we revoke its underlying device).
export async function loadDeviceById(deviceId: string): Promise<schema.Device | null> {
  const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, deviceId)).limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  return row;
}

// "My devices" management page. Returns un-revoked devices in created-order.
export async function listDevicesForUser(userId: string) {
  return db
    .select({
      id: schema.devices.id,
      label: schema.devices.label,
      kind: schema.devices.kind,
      refreshTokenPrefix: schema.devices.refreshTokenPrefix,
      appVersion: schema.devices.appVersion,
      lastSeenAt: schema.devices.lastSeenAt,
      lastSeenIp: schema.devices.lastSeenIp,
      firstSeenIp: schema.devices.firstSeenIp,
      firstUserAgent: schema.devices.firstUserAgent,
      createdAt: schema.devices.createdAt,
    })
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, userId), isNull(schema.devices.revokedAt)))
    .orderBy(asc(schema.devices.createdAt));
}

export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.devices.id, userId: schema.devices.userId })
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
    .limit(1);
  if (!row || row.userId !== userId) return false;
  await db
    .update(schema.devices)
    .set({ revokedAt: new Date() })
    .where(eq(schema.devices.id, deviceId));
  return true;
}

// Called by housekeeping cron. Cleans up two kinds of stale data:
//   - Pairing rows expired more than a day ago (we keep one day for audit)
//   - Devices revoked more than 90 days ago
export async function purgeStaleDeviceRows(): Promise<{ pairings: number; devices: number }> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const pair = await db
    .delete(schema.devicePairings)
    .where(lt(schema.devicePairings.expiresAt, oneDayAgo))
    .returning({ id: schema.devicePairings.id });
  const dev = await db
    .delete(schema.devices)
    .where(and(
      lt(schema.devices.revokedAt, ninetyDaysAgo),
      // gt is just to satisfy Drizzle's not-undefined; revoked_at is non-null by
      // the lt above (lt returns false on nulls in PG).
      gt(schema.devices.createdAt, new Date(0)),
    ))
    .returning({ id: schema.devices.id });
  return { pairings: pair.length, devices: dev.length };
}
