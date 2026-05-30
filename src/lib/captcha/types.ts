// Shared types for the pluggable human-verification (CAPTCHA) module.
//
// This module replaces the legacy arithmetic captcha in ../captcha.ts with a
// provider-based design. Site admins pick ONE provider:
//
//   - "none"      → verification disabled (no widget, verify always passes).
//   - "builtin"   → self-hosted, offline, no-CDN invisible Proof-of-Work.
//                   The default for privacy- / China-reachability-sensitive
//                   deployments. No "readable answer" exists: the browser must
//                   actually burn CPU to find a hash preimage, so opening F12
//                   reveals nothing that lets a bot skip the work.
//   - "turnstile" → Cloudflare Turnstile (loads challenges.cloudflare.com).
//   - "recaptcha" → Google reCAPTCHA v2 checkbox (loads www.google.com).
//   - "hcaptcha"  → hCaptcha (loads js.hcaptcha.com; privacy-friendly, GDPR).
//
// turnstile / recaptcha / hcaptcha are OPTIONAL and load third-party scripts; they are
// off by default precisely because this project ships no foreign CDNs unless
// the operator opts in.

export type CaptchaProvider = "none" | "builtin" | "turnstile" | "recaptcha" | "hcaptcha";

export const CAPTCHA_PROVIDERS: readonly CaptchaProvider[] = [
  "none",
  "builtin",
  "turnstile",
  "recaptcha",
  "hcaptcha",
] as const;

export function isCaptchaProvider(v: unknown): v is CaptchaProvider {
  return typeof v === "string" && (CAPTCHA_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Admin-configured captcha settings. `siteKey` / `secret` are only meaningful
 * for the third-party providers (turnstile / recaptcha); for "builtin" they
 * are ignored and the SESSION_SECRET signing key is used instead.
 */
export type CaptchaConfig = {
  provider: CaptchaProvider;
  siteKey?: string | null;
  secret?: string | null;
};

/**
 * Data the view layer needs to render the client widget. Returned by
 * getClientRender(). `builtin.challenge` is a stateless, HMAC-signed token —
 * it carries NO answer, only a signed (challenge, difficulty, expiry) tuple.
 */
export type ClientRender = {
  provider: CaptchaProvider;
  /** Public site key for turnstile / recaptcha. null/undefined otherwise. */
  siteKey?: string | null;
  /** Present only when provider === "builtin". */
  builtin?: {
    /**
     * Signed, opaque token. The client echoes it back UNCHANGED on submit; it
     * carries the (challenge, salt, difficulty, expiry) tuple, signed. The
     * client does NOT hash this — it hashes the raw `challenge` below.
     */
    token: string;
    /** Raw random challenge string the client hashes (public, not secret). */
    challenge: string;
    /** Random hex the client hashes together with challenge + nonce. */
    salt: string;
    /** Number of leading zero BITS the sha256 digest must have. */
    difficulty: number;
    /** Unix-ms expiry; the widget can show a "refresh" affordance past it. */
    expiresAt: number;
  };
};

/** Result of a server-side verification. `reason` is for logs, not end users. */
export type VerifyResult = { ok: boolean; reason?: string };
