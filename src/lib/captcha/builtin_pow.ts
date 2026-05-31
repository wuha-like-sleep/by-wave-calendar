// Invisible Proof-of-Work (PoW) human-verification — self-hosted, offline,
// no third-party CDN, no "readable answer".
//
// =============================== THREAT MODEL ===============================
// The legacy captcha printed "3 + 5 =" and HMAC-signed the answer. A bot that
// can read the page (everyone) can also read the question and compute 8 — the
// "answer" is right there. The only friction was a tiny HMAC the bot never
// needed to forge (it just answered honestly). That's the "F12 reveals the
// answer" failure mode we must eliminate.
//
// PoW fixes this by having NO answer to read. The server hands out a random
// `challenge` + `salt` and a `difficulty` (a number of required leading zero
// BITS). The client must find ANY `nonce` such that:
//
//        sha256(challenge + ":" + salt + ":" + nonce)  starts with
//        `difficulty` zero bits.
//
// There is no shortcut: sha256 is a one-way function, so the only way to find
// such a nonce is brute force — on average 2^difficulty hash attempts. The
// "answer" (a valid nonce) does not exist until the browser spends CPU to mint
// it. Opening DevTools shows the challenge and the difficulty, but knowing
// those is exactly what an honest solver already has; it grants no shortcut.
//
// ============================ WHY IT'S STATELESS ============================
// We don't store issued challenges in a DB/session (no state, scales freely,
// survives restarts). Instead the challenge is an HMAC-signed token:
//
//        token = b64url(payloadJson) + "." + hmac(SESSION_SECRET, payloadJson)
//
// payload = { c: challenge, s: salt, d: difficulty, exp: expiryMs }
//
// On verify we (1) recompute the HMAC and timing-safe-compare it (so the
// client can't lie about a LOWER difficulty or a LATER expiry — any tamper
// breaks the signature), (2) check it hasn't expired, and (3) check the
// submitted nonce actually satisfies the difficulty for the signed challenge.
// The signing key never leaves the server, so tokens are unforgeable.
//
// ============================== ANTI-REPLAY ================================
// A signed token + nonce pair is reusable until it expires (statelessness's
// tradeoff). That's acceptable here: this gate sits in front of the existing
// per-IP rate limit, honeypot, and mandatory email-code verification, and a
// SHORT ttl bounds reuse. Callers that want strict single-use can additionally
// remember spent (challenge,nonce) pairs in their own store, but the per-IP
// auth rate limit already caps how fast one token can be replayed. Difficulty
// is the real cost lever: it forces fresh CPU per *distinct* challenge, and we
// mint a fresh challenge on every GET /register.

import crypto from "node:crypto";
import { env } from "../../env.js";

/** Default leading-zero-bit difficulty. ~2^16 hashes ≈ 0.1–0.5s in-browser. */
export const DEFAULT_DIFFICULTY = 16;

/** Safety rails so a bad config can't DoS honest users or weaken the gate. */
const MIN_DIFFICULTY = 8;
const MAX_DIFFICULTY = 24;

/** How long a minted challenge stays solvable+submittable. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

type Payload = {
  /** challenge */ c: string;
  /** salt */ s: string;
  /** difficulty (leading zero bits) */ d: number;
  /** expiry, unix ms */ exp: number;
};

export type Challenge = {
  token: string;
  salt: string;
  challenge: string;
  difficulty: number;
  expiresAt: number;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64: string): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(payloadB64).digest("hex");
}

function clampDifficulty(d: number): number {
  if (!Number.isFinite(d)) return DEFAULT_DIFFICULTY;
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.floor(d)));
}

/**
 * Mint a fresh, stateless, signed PoW challenge. The returned token contains
 * NO solution — only the (challenge, salt, difficulty, expiry) tuple, signed.
 */
export function issueChallenge(difficulty: number = DEFAULT_DIFFICULTY): Challenge {
  const d = clampDifficulty(difficulty);
  const challenge = crypto.randomBytes(16).toString("hex");
  const salt = crypto.randomBytes(8).toString("hex");
  const exp = Date.now() + TTL_MS;
  const payload: Payload = { c: challenge, s: salt, d, exp };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = sign(payloadB64);
  return { token: `${payloadB64}.${mac}`, salt, challenge, difficulty: d, expiresAt: exp };
}

/** Count leading zero BITS of a digest buffer (MSB-first). */
function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    // Math.clz32 on an 8-bit value: subtract the 24 high zero bits of the int.
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** The exact preimage the client hashes. Kept in one place for parity. */
export function powPreimage(challenge: string, salt: string, nonce: string): string {
  return `${challenge}:${salt}:${nonce}`;
}

/** True iff sha256(challenge:salt:nonce) has >= difficulty leading zero bits. */
export function satisfiesDifficulty(
  challenge: string,
  salt: string,
  nonce: string,
  difficulty: number,
): boolean {
  const digest = crypto.createHash("sha256").update(powPreimage(challenge, salt, nonce)).digest();
  return leadingZeroBits(digest) >= difficulty;
}

/** Parse + signature-verify a token. Returns the payload or null if invalid. */
function openToken(token: string): Payload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payloadB64);
  // Constant-time compare; bail if lengths differ (timingSafeEqual throws).
  if (mac.length !== expected.length) return null;
  let macOk: boolean;
  try {
    macOk = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return null;
  }
  if (!macOk) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as Payload).c !== "string" ||
    typeof (payload as Payload).s !== "string" ||
    typeof (payload as Payload).d !== "number" ||
    typeof (payload as Payload).exp !== "number"
  ) {
    return null;
  }
  return payload as Payload;
}

// ============================ ANTI-REPLAY (single-use) =====================
// Remember solved challenges until they expire so the same solved (token,nonce)
// can't be replayed across many registrations. An entry is recorded ONLY AFTER
// the PoW work checks out, so each entry costs an attacker a full 2^difficulty
// solve; entries self-expire at the token's own TTL, bounding memory. The
// challenge `c` is 16 random bytes minted per GET /register, so it's a natural
// single-use key.
//
// NOTE: in-memory + per-process. In a multi-instance deployment a token could
// be replayed at most once per instance; the per-IP auth rate limit still
// bounds total throughput. For the single-process self-hosted server this gives
// true one-shot semantics. A shared store (Redis/DB) would make it strict
// across instances if ever needed.
const spentChallenges = new Map<string, number>(); // challenge -> expiryMs
const SPENT_SOFT_CAP = 50_000;

function pruneSpent(now: number): void {
  for (const [k, exp] of spentChallenges) {
    if (exp <= now) spentChallenges.delete(k);
  }
}

/** Record a solved challenge as spent. Returns false if it was already spent
 *  (a replay) within its TTL. Only call AFTER the work has been verified. */
function consumeChallenge(challenge: string, exp: number): boolean {
  const now = Date.now();
  const prev = spentChallenges.get(challenge);
  if (prev !== undefined && prev > now) return false; // replay within TTL
  if (spentChallenges.size > SPENT_SOFT_CAP) pruneSpent(now);
  spentChallenges.set(challenge, exp);
  return true;
}

export type VerifyChallengeResult = { ok: boolean; reason?: string };

/**
 * Verify a solved challenge.
 *
 *  1. Signature must be intact (no tampered difficulty/expiry/challenge).
 *  2. Token must not have expired.
 *  3. sha256(challenge:salt:nonce) must actually meet the signed difficulty.
 *
 * `nonce` is bounded in length by the caller's schema; we additionally guard
 * here so a pathological value can't waste a hash.
 */
export function verifyChallenge(
  token: string | undefined | null,
  nonce: string | undefined | null,
): VerifyChallengeResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing_token" };
  if (!nonce || typeof nonce !== "string" || nonce.length > 64) {
    return { ok: false, reason: "missing_nonce" };
  }
  const payload = openToken(token);
  if (!payload) return { ok: false, reason: "bad_signature" };
  if (Date.now() > payload.exp) return { ok: false, reason: "expired" };
  // Re-clamp the signed difficulty defensively (it was clamped at issue time,
  // but never trust a parsed number to be in range).
  const difficulty = clampDifficulty(payload.d);
  if (!satisfiesDifficulty(payload.c, payload.s, nonce, difficulty)) {
    return { ok: false, reason: "insufficient_work" };
  }
  // Single-use: a solved challenge can be redeemed exactly once within its TTL.
  // This is what stops a bot from solving one PoW and replaying it for many
  // registrations. Done last, so only genuinely-solved challenges are recorded.
  if (!consumeChallenge(payload.c, payload.exp)) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true };
}
