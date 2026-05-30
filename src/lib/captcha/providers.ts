// Server-side verification for the OPTIONAL third-party captcha providers:
// Cloudflare Turnstile and Google reCAPTCHA (v2 checkbox).
//
// These call the providers' well-known, fixed siteverify endpoints — NOT
// user-supplied URLs — so the project's SSRF guard does not apply here (that
// guard exists to stop fetches to *attacker-chosen* hosts like internal IPs).
// The endpoints below are constant string literals; there is no way for a
// request to redirect this fetch to an internal target.
//
// Both endpoints take an application/x-www-form-urlencoded POST of:
//   secret   = admin's private key (from site settings)
//   response = the token the browser widget produced
//   remoteip = the client IP (optional but recommended)
// and return JSON `{ success: boolean, ... }`.

import type { VerifyResult } from "./types.js";

const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RECAPTCHA_ENDPOINT = "https://www.google.com/recaptcha/api/siteverify";
const HCAPTCHA_ENDPOINT = "https://api.hcaptcha.com/siteverify";

/** Network timeout so a slow/hung provider can't pin a registration request. */
const VERIFY_TIMEOUT_MS = 8000;

type SiteVerifyResponse = {
  success?: boolean;
  "error-codes"?: string[];
  [k: string]: unknown;
};

async function postSiteVerify(
  endpoint: string,
  secret: string,
  response: string,
  remoteIp?: string,
): Promise<VerifyResult> {
  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", response);
  if (remoteIp) params.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = (await res.json()) as SiteVerifyResponse;
    if (data.success === true) return { ok: true };
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].join(",") : "no_success";
    return { ok: false, reason: `provider_rejected:${codes}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "provider_timeout" : "provider_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp?: string,
): Promise<VerifyResult> {
  return postSiteVerify(TURNSTILE_ENDPOINT, secret, token, remoteIp);
}

export function verifyRecaptcha(
  secret: string,
  token: string,
  remoteIp?: string,
): Promise<VerifyResult> {
  return postSiteVerify(RECAPTCHA_ENDPOINT, secret, token, remoteIp);
}

export function verifyHcaptcha(
  secret: string,
  token: string,
  remoteIp?: string,
): Promise<VerifyResult> {
  // hCaptcha's siteverify is byte-compatible with the others (secret/response/
  // remoteip → { success }).
  return postSiteVerify(HCAPTCHA_ENDPOINT, secret, token, remoteIp);
}
