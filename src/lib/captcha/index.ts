// Unified façade for the pluggable human-verification (CAPTCHA) module.
//
// The web layer only ever needs two functions from here:
//
//   getClientRender(config)              → data to render the widget in a view
//   verifyCaptcha(config, body, ip?)     → server-side pass/fail on submit
//
// Everything provider-specific (PoW math, Turnstile/reCAPTCHA siteverify) is
// dispatched on config.provider and lives in sibling files. See INTEGRATION.md
// for how to wire this into GET/POST /register, register.ejs, and the admin
// settings page.

import { issueChallenge, verifyChallenge } from "./builtin_pow.js";
import { verifyRecaptcha, verifyTurnstile } from "./providers.js";
import type { CaptchaConfig, ClientRender, VerifyResult } from "./types.js";

export type { CaptchaConfig, CaptchaProvider, ClientRender, VerifyResult } from "./types.js";
export { CAPTCHA_PROVIDERS, isCaptchaProvider } from "./types.js";
export { issueChallenge, verifyChallenge, DEFAULT_DIFFICULTY } from "./builtin_pow.js";

// ----------------------------------------------------------------------------
// Form field names. The client widget writes these hidden inputs; the server
// reads them in verifyCaptcha(). Keep client (bwc-captcha.js) and server in
// sync via these constants — they are the integration contract.
// ----------------------------------------------------------------------------
export const FIELD = {
  /**
   * builtin: the SIGNED challenge token, echoed back unchanged. The server
   * passes this to verifyChallenge() as the token (it carries the raw
   * challenge, salt, difficulty and expiry inside its signed payload). The
   * client does NOT hash this value — it hashes the raw challenge string.
   */
  challenge: "bwc-captcha-challenge",
  /** builtin: the nonce the browser found by brute-forcing the hash. */
  nonce: "bwc-captcha-nonce",
  /** turnstile / recaptcha: the token produced by the third-party widget. */
  token: "bwc-captcha-token",
} as const;

/** Shape of the parsed form fields verifyCaptcha() consumes. */
export type CaptchaFormBody = {
  [FIELD.challenge]?: string;
  [FIELD.nonce]?: string;
  [FIELD.token]?: string;
};

/**
 * Build the data a view needs to render the widget. For "builtin" this mints a
 * fresh signed PoW challenge (call it once per page render so each visitor gets
 * a unique challenge). For third-party providers it just surfaces the public
 * site key. For "none" it returns the provider tag and nothing else.
 */
export function getClientRender(config: CaptchaConfig): ClientRender {
  switch (config.provider) {
    case "builtin": {
      const ch = issueChallenge();
      return {
        provider: "builtin",
        builtin: {
          token: ch.token,
          challenge: ch.challenge,
          salt: ch.salt,
          difficulty: ch.difficulty,
          expiresAt: ch.expiresAt,
        },
      };
    }
    case "turnstile":
    case "recaptcha":
      return { provider: config.provider, siteKey: config.siteKey ?? null };
    case "none":
    default:
      return { provider: "none" };
  }
}

/**
 * Verify a submission. Dispatches on provider. Never throws — always resolves
 * to { ok, reason? }. `reason` is diagnostic (for logs), NOT a user message.
 *
 * Misconfiguration policy: if a third-party provider is selected but its secret
 * is missing, we FAIL CLOSED (ok:false) rather than letting bots through. The
 * "none" provider is the only way to intentionally disable verification.
 */
export async function verifyCaptcha(
  config: CaptchaConfig,
  body: CaptchaFormBody | undefined,
  remoteIp?: string,
): Promise<VerifyResult> {
  const b = body ?? {};
  switch (config.provider) {
    case "none":
      return { ok: true };

    case "builtin":
      return verifyChallenge(b[FIELD.challenge], b[FIELD.nonce]);

    case "turnstile": {
      const secret = config.secret?.trim();
      if (!secret) return { ok: false, reason: "missing_secret" };
      const token = b[FIELD.token];
      if (!token) return { ok: false, reason: "missing_token" };
      return verifyTurnstile(secret, token, remoteIp);
    }

    case "recaptcha": {
      const secret = config.secret?.trim();
      if (!secret) return { ok: false, reason: "missing_secret" };
      const token = b[FIELD.token];
      if (!token) return { ok: false, reason: "missing_token" };
      return verifyRecaptcha(secret, token, remoteIp);
    }

    default:
      // Unknown provider → fail closed.
      return { ok: false, reason: "unknown_provider" };
  }
}
