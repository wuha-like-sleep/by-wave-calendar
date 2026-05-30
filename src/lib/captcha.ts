// Self-hosted human-verification (CAPTCHA) for the public registration form.
//
// Why self-hosted (no hCaptcha / reCAPTCHA / Turnstile): this project
// deliberately ships zero third-party front-end resources and no foreign
// CDNs (privacy + China-reachability). So we mint a tiny arithmetic
// challenge ourselves and HMAC-sign the answer with SESSION_SECRET.
//
// How it works:
//   - issueCaptcha() picks "a + b", computes the answer, and returns the
//     question text + a stateless token = `${exp}.${nonce}.${hmac}` where
//     hmac = HMAC(secret, `${answer}|${exp}|${nonce}`). The token does NOT
//     contain the answer, so a bot can't read it off the page.
//   - The form shows the question + carries the token in a hidden field.
//   - verifyCaptcha(token, userAnswer) re-derives the HMAC over the SUBMITTED
//     answer and constant-time-compares it to the token's hmac. Only the
//     correct answer reproduces the signature; expiry bounds replay.
//
// This is intentionally lightweight — paired with the existing honeypot,
// per-IP rate limit, and the mandatory email verification code, it raises
// the cost of automated mass-registration / email-bombing without a
// third-party dependency or an accessibility-hostile image puzzle.

import crypto from "node:crypto";
import { env } from "../env.js";

const TTL_MS = 10 * 60 * 1000; // 10 minutes to solve + submit

function sign(answer: number, exp: number, nonce: string): string {
  return crypto
    .createHmac("sha256", env.SESSION_SECRET)
    .update(`${answer}|${exp}|${nonce}`)
    .digest("hex");
}

export function issueCaptcha(): { question: string; token: string } {
  const a = 1 + crypto.randomInt(9); // 1..9
  const b = 1 + crypto.randomInt(9); // 1..9
  const answer = a + b;
  const exp = Date.now() + TTL_MS;
  const nonce = crypto.randomBytes(6).toString("hex");
  const mac = sign(answer, exp, nonce);
  return { question: `${a} + ${b}`, token: `${exp}.${nonce}.${mac}` };
}

/** True iff `userAnswer` is the correct answer for an unexpired, untampered token. */
export function verifyCaptcha(token: string | undefined, userAnswer: string | undefined): boolean {
  if (!token || !userAnswer) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, mac] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const answer = Number(userAnswer.trim());
  if (!Number.isInteger(answer)) return false;
  const expected = sign(answer, exp, nonce);
  // Guard length before timingSafeEqual (it throws on mismatched lengths).
  if (mac.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}
