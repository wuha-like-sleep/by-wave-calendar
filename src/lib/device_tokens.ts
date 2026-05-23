// Token primitives for the native-app device-pairing flow.
//
// Two token types:
//   - Refresh token: opaque, long-lived (no expiry by default). Format
//     `bwd_<8-char-prefix>_<32-char-secret>`. Bcrypt-hashed at rest;
//     the prefix is indexed so we can look up rows in O(log n).
//     Exchanged for access tokens via /api/v1/auth/refresh.
//   - Access token: standard JWT (HS256, signed with SESSION_SECRET),
//     1-hour TTL. Carries { sub: userId, did: deviceId, exp, iat }.
//     Sent as Authorization: Bearer <jwt> on every API request.
//
// Why this split instead of just long-lived tokens like apiTokens?
//   - Refresh tokens live in the device's secure storage (Keychain /
//     Keystore). They're rarely sent over the wire so a logging mishap
//     can't leak them as easily as a long-lived bearer.
//   - Access tokens are short-lived, so a brief logging leak or a
//     compromised access log auto-expires within an hour.
//   - Rotation is cheap: we can blacklist a device's refresh token
//     and the app loses access within 1 hour without any client cooperation.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { hashPassword, verifyPassword } from "./password.js";

// --- Refresh token format -------------------------------------------------
const PREFIX_LEN = 8;
const SECRET_LEN = 32;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
const TOKEN_LITERAL = "bwd_";

function randomFrom(alphabet: string, len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function looksLikeRefreshToken(s: string): boolean {
  return /^bwd_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/.test(s);
}

export function extractRefreshTokenPrefix(token: string): string | null {
  const m = token.match(/^bwd_([A-Za-z0-9]{8})_/);
  return m ? (m[1] ?? null) : null;
}

export type IssuedRefreshToken = { plain: string; prefix: string; hash: string };

export async function issueRefreshToken(): Promise<IssuedRefreshToken> {
  const prefix = randomFrom(ALPHABET, PREFIX_LEN);
  const secret = randomFrom(ALPHABET, SECRET_LEN);
  const plain = `${TOKEN_LITERAL}${prefix}_${secret}`;
  const hash = await hashPassword(plain);
  return { plain, prefix, hash };
}

export async function verifyRefreshToken(plain: string, hash: string): Promise<boolean> {
  if (!looksLikeRefreshToken(plain)) return false;
  return verifyPassword(plain, hash);
}

// --- Access token (JWT) ---------------------------------------------------
// Minimal HS256 JWT — no library needed. Header is constant.

const ACCESS_TOKEN_TTL_SEC = 60 * 60;  // 1 hour
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export type AccessTokenPayload = {
  sub: string;   // user id
  did: string;   // device id
  iat: number;
  exp: number;
};

export function signAccessToken(userId: string, deviceId: string): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_SEC;
  const payload: AccessTokenPayload = { sub: userId, did: deviceId, iat: now, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", env.SESSION_SECRET).update(`${JWT_HEADER}.${body}`).digest("base64url");
  return { token: `${JWT_HEADER}.${body}.${sig}`, expiresAt: new Date(exp * 1000) };
}

// Verify a JWT and return its payload, or null on any failure (bad shape,
// bad signature, expired). Uses timing-safe comparison on the signature.
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  // We only issue with our constant header. Anything else → reject.
  if (header !== JWT_HEADER) return null;
  const expected = createHmac("sha256", env.SESSION_SECRET).update(`${header}.${body}`).digest("base64url");
  let expectedBuf: Buffer;
  let sigBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "base64url");
    sigBuf = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (expectedBuf.length !== sigBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || typeof payload.did !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// JWTs start with eyJ (base64-encoded "{") which is a quick rejection
// check before we bother base64-decoding the whole header. Used by the
// session middleware to decide whether to try this code path at all.
export function looksLikeAccessToken(token: string): boolean {
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

// --- Pairing code ---------------------------------------------------------
// 6 character codes are short enough for a manual fallback ("type it in")
// while having ~36^6 = 2.2 billion possibilities (well past brute-force
// in a 5-minute window given the rate limit). Skip ambiguous chars (0/O, 1/I).
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePairingCode(): string {
  return randomFrom(PAIRING_ALPHABET, 6);
}

// Hash used for pairing code lookup-by-code in a single indexed read.
// We don't bcrypt these — they're already random + short-lived + unique.
export function pairingCodeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
