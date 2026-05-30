import { describe, it, expect } from "vitest";
import { issueCaptcha, verifyCaptcha } from "../src/lib/captcha.js";

/** Parse the "a + b" question and compute the right answer. */
function solve(question: string): number {
  const m = question.match(/^(\d+)\s*\+\s*(\d+)$/);
  if (!m) throw new Error(`unexpected question: ${question}`);
  return Number(m[1]) + Number(m[2]);
}

describe("captcha", () => {
  it("accepts the correct answer for a fresh token", () => {
    const { question, token } = issueCaptcha();
    expect(verifyCaptcha(token, String(solve(question)))).toBe(true);
    // whitespace tolerated
    expect(verifyCaptcha(token, ` ${solve(question)} `)).toBe(true);
  });

  it("rejects a wrong answer", () => {
    const { question, token } = issueCaptcha();
    expect(verifyCaptcha(token, String(solve(question) + 1))).toBe(false);
    expect(verifyCaptcha(token, "0")).toBe(false);
  });

  it("rejects non-numeric / empty answers", () => {
    const { token } = issueCaptcha();
    expect(verifyCaptcha(token, "abc")).toBe(false);
    expect(verifyCaptcha(token, "")).toBe(false);
    expect(verifyCaptcha(token, undefined)).toBe(false);
  });

  it("rejects a missing / malformed token", () => {
    expect(verifyCaptcha(undefined, "5")).toBe(false);
    expect(verifyCaptcha("", "5")).toBe(false);
    expect(verifyCaptcha("garbage", "5")).toBe(false);
    expect(verifyCaptcha("a.b", "5")).toBe(false);
  });

  it("rejects a tampered HMAC", () => {
    const { question, token } = issueCaptcha();
    const answer = String(solve(question));
    const parts = token.split(".");
    // Flip the last hex char of the mac.
    const mac = parts[2]!;
    const flipped = mac.slice(0, -1) + (mac.slice(-1) === "0" ? "1" : "0");
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    expect(verifyCaptcha(tampered, answer)).toBe(false);
  });

  it("rejects an expired token", () => {
    const { question, token } = issueCaptcha();
    const answer = String(solve(question));
    // Force the expiry into the past; the HMAC no longer matches the
    // (now-past) exp either, so it fails on both counts — which is fine.
    const parts = token.split(".");
    const expired = `${Date.now() - 1000}.${parts[1]}.${parts[2]}`;
    expect(verifyCaptcha(expired, answer)).toBe(false);
  });
});
