// Sign in with Apple — identity-token verification (#67).
//
// Flow (native iOS app variant):
//   1. iOS app shows ASAuthorizationAppleIDButton; user authorizes.
//   2. Apple hands the app an `identityToken` — a signed RS256 JWT.
//   3. App POSTs it to /api/v1/auth/apple.
//   4. THIS module verifies that JWT against Apple's public keys (JWKS),
//      checks issuer + audience + expiry, and returns the trustworthy
//      claims (sub, email). The route then links/creates the user.
//
// Why verify server-side (never trust the app's word): the identityToken is
// the ONLY thing we can cryptographically trust. The app could lie about
// the email/sub in a plain JSON field — but it can't forge Apple's RS256
// signature. So we ignore any app-supplied identity fields and read only
// what's inside the verified token.
//
// We use `jose`'s remote JWKS with built-in caching + cooldown, so we don't
// hammer Apple's key endpoint on every login.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../env.js";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

// createRemoteJWKSet caches keys in-process and refreshes on unknown `kid`
// (with a cooldown to prevent abuse). One shared instance for the process.
const appleJwks = createRemoteJWKSet(APPLE_JWKS_URL);

/** Accepted `aud` values — the bundle ID (native) and/or Service ID (web).
 *  SIWA_CLIENT_IDS is comma-separated; falls back to APNS_BUNDLE_ID so a
 *  deployment that already set the bundle id for push doesn't have to
 *  repeat it. Empty list ⇒ feature disabled (route returns 503). */
export function appleClientIds(): string[] {
  const raw = env.SIWA_CLIENT_IDS?.trim() || env.APNS_BUNDLE_ID?.trim() || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function appleSignInConfigured(): boolean {
  return appleClientIds().length > 0;
}

export type AppleClaims = {
  /** Stable, opaque per-user id. The thing we store + re-link on. */
  sub: string;
  /** Email Apple released to us. May be a private-relay address, or absent
   *  if the user revoked email sharing on a re-login. */
  email: string | null;
  /** Apple's "is this email verified" claim (string "true"/"false" or bool). */
  emailVerified: boolean;
  /** True when Apple flags the email as one of its private-relay proxies. */
  isPrivateRelay: boolean;
};

/**
 * Verify an Apple identity token and return its trustworthy claims, or throw
 * with a stable `code` on any failure. The route maps these to 4xx without
 * leaking crypto details to the client.
 */
export async function verifyAppleIdentityToken(identityToken: string): Promise<AppleClaims> {
  const auds = appleClientIds();
  if (auds.length === 0) {
    throw new AppleVerifyError("not_configured", "Sign in with Apple is not configured on this server");
  }
  if (!identityToken || typeof identityToken !== "string" || identityToken.length > 8192) {
    throw new AppleVerifyError("bad_token", "missing or malformed identity token");
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(identityToken, appleJwks, {
      issuer: APPLE_ISSUER,
      audience: auds,          // jose accepts an array → matches any one
      // Apple tokens are RS256; jose enforces the alg from the JWKS key,
      // but pin it explicitly so a downgraded `alg: none` token is rejected.
      algorithms: ["RS256"],
      // small clock tolerance for device/server skew
      clockTolerance: 30,
    });
    payload = result.payload;
  } catch (err) {
    // jose throws typed errors (expired, signature, audience, issuer…). We
    // collapse them to one opaque code — the client only needs "didn't work,"
    // and detailed reasons could help an attacker probe.
    throw new AppleVerifyError("verify_failed", err instanceof Error ? err.message : "token verification failed");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new AppleVerifyError("no_sub", "token missing sub");

  // email_verified + is_private_email arrive as strings ("true"/"false") in
  // Apple tokens, sometimes as booleans. Normalize both shapes.
  const rawEmail = typeof payload.email === "string" ? payload.email.toLowerCase().trim() : null;
  const emailVerified = coerceBool(payload.email_verified);
  const isPrivateRelay = coerceBool(payload.is_private_email);

  return {
    sub,
    email: rawEmail || null,
    emailVerified,
    isPrivateRelay,
  };
}

function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;
}

export class AppleVerifyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "AppleVerifyError";
  }
}
