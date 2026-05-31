import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  issueChallenge,
  verifyChallenge,
  satisfiesDifficulty,
  powPreimage,
  DEFAULT_DIFFICULTY,
} from "../src/lib/captcha/builtin_pow.js";
import { getClientRender, verifyCaptcha, FIELD } from "../src/lib/captcha/index.js";

// SESSION_SECRET must be present for env.ts to load (it imports it). Vitest
// runs with NODE_ENV=test; provide a long-enough secret + the few required
// env vars so the schema parses. Set before any import that reads env — but
// since imports are hoisted, we rely on these being in process.env already.
// (env.ts only needs SESSION_SECRET/DATABASE_URL/PUBLIC_BASE_URL to parse.)

/** Count leading zero bits of a hex digest, mirroring the server. */
function leadingZeroBitsHex(hex: string): number {
  let bits = 0;
  for (const ch of hex) {
    const nibble = parseInt(ch, 16);
    if (nibble === 0) { bits += 4; continue; }
    if (nibble >= 8) bits += 0;
    else if (nibble >= 4) bits += 1;
    else if (nibble >= 2) bits += 2;
    else bits += 3;
    break;
  }
  return bits;
}

/** Brute-force a valid nonce the same way the browser would. */
function solvePow(challenge: string, salt: string, difficulty: number): string {
  for (let n = 0; ; n++) {
    const digest = crypto.createHash("sha256").update(powPreimage(challenge, salt, String(n))).digest("hex");
    if (leadingZeroBitsHex(digest) >= difficulty) return String(n);
  }
}

describe("builtin PoW captcha", () => {
  it("default difficulty is the documented value", () => {
    expect(DEFAULT_DIFFICULTY).toBe(16);
  });

  it("issue → solve → verify passes (low difficulty for test speed)", () => {
    const ch = issueChallenge(10);
    expect(ch.difficulty).toBe(10);
    const nonce = solvePow(ch.challenge, ch.salt, ch.difficulty);
    expect(satisfiesDifficulty(ch.challenge, ch.salt, nonce, ch.difficulty)).toBe(true);
    expect(verifyChallenge(ch.token, nonce)).toEqual({ ok: true });
  });

  it("is single-use: replaying the same solved token+nonce is rejected", () => {
    const ch = issueChallenge(10);
    const nonce = solvePow(ch.challenge, ch.salt, ch.difficulty);
    // First redemption succeeds.
    expect(verifyChallenge(ch.token, nonce)).toEqual({ ok: true });
    // A replay of the exact same (token, nonce) within its TTL must fail —
    // this is what stops a bot solving one PoW and reusing it for many signups.
    expect(verifyChallenge(ch.token, nonce)).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects a wrong / non-solving nonce", () => {
    const ch = issueChallenge(12);
    // "0" almost certainly does not satisfy 12 leading zero bits.
    const r = verifyChallenge(ch.token, "0");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_work");
  });

  it("rejects a tampered token (flipped MAC char)", () => {
    const ch = issueChallenge(10);
    const nonce = solvePow(ch.challenge, ch.salt, ch.difficulty);
    const dot = ch.token.indexOf(".");
    const mac = ch.token.slice(dot + 1);
    const flipped = mac.slice(0, -1) + (mac.slice(-1) === "0" ? "1" : "0");
    const tampered = ch.token.slice(0, dot + 1) + flipped;
    expect(verifyChallenge(tampered, nonce)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload (lowered difficulty)", () => {
    // Forge a payload claiming difficulty 0 but keep the original signature —
    // the signature won't match the modified payload, so it must be rejected.
    const ch = issueChallenge(14);
    const dot = ch.token.indexOf(".");
    const payloadB64 = ch.token.slice(0, dot);
    const mac = ch.token.slice(dot + 1);
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    payload.d = 0; // attacker tries to require zero work
    const forgedB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${forgedB64}.${mac}`;
    expect(verifyChallenge(forged, "0")).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token (re-signed with past expiry can't help an attacker)", () => {
    // An attacker cannot re-sign (no SESSION_SECRET), so a genuinely expired
    // token still carries a valid signature but a past `exp`. Simulate by
    // issuing then waiting is too slow; instead assert the expiry branch via a
    // token we know is expired: forge a past exp WITHOUT a valid sig fails at
    // signature first, which still yields ok:false. To exercise the expiry
    // branch specifically we monkeypatch Date.now forward.
    const ch = issueChallenge(10);
    const nonce = solvePow(ch.challenge, ch.salt, ch.difficulty);
    const realNow = Date.now;
    try {
      // Jump 11 minutes ahead (TTL is 10m).
      Date.now = () => realNow() + 11 * 60 * 1000;
      expect(verifyChallenge(ch.token, nonce)).toEqual({ ok: false, reason: "expired" });
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects missing token / nonce", () => {
    expect(verifyChallenge(undefined, "1").ok).toBe(false);
    expect(verifyChallenge("", "1").ok).toBe(false);
    expect(verifyChallenge("a.b", "1").ok).toBe(false);
    const ch = issueChallenge(10);
    expect(verifyChallenge(ch.token, undefined).ok).toBe(false);
    expect(verifyChallenge(ch.token, "").ok).toBe(false);
  });

  it("rejects an over-long nonce without hashing it", () => {
    const ch = issueChallenge(10);
    const r = verifyChallenge(ch.token, "x".repeat(65));
    expect(r).toEqual({ ok: false, reason: "missing_nonce" });
  });

  it("clamps difficulty into the safe range", () => {
    expect(issueChallenge(1).difficulty).toBeGreaterThanOrEqual(8);
    expect(issueChallenge(99).difficulty).toBeLessThanOrEqual(24);
    expect(issueChallenge(NaN).difficulty).toBe(DEFAULT_DIFFICULTY);
  });

  it("difficulty boundary: a digest with exactly N leading zero bits passes at N, fails at N+1", () => {
    // Construct a preimage and find its leading-zero-bit count, then assert
    // verify thresholds around it via satisfiesDifficulty (pure function).
    const challenge = "abc";
    const salt = "def";
    const nonce = solvePow(challenge, salt, 8); // >= 8 leading zero bits
    const digest = crypto.createHash("sha256").update(powPreimage(challenge, salt, nonce)).digest("hex");
    const lz = leadingZeroBitsHex(digest);
    expect(satisfiesDifficulty(challenge, salt, nonce, lz)).toBe(true);
    expect(satisfiesDifficulty(challenge, salt, nonce, lz + 1)).toBe(false);
  });
});

describe("captcha façade", () => {
  it("provider 'none' renders nothing and always verifies ok", async () => {
    expect(getClientRender({ provider: "none" })).toEqual({ provider: "none" });
    expect(await verifyCaptcha({ provider: "none" }, {})).toEqual({ ok: true });
  });

  it("builtin façade: getClientRender mints a challenge that verifyCaptcha accepts", async () => {
    const render = getClientRender({ provider: "builtin" });
    expect(render.provider).toBe("builtin");
    expect(render.builtin).toBeTruthy();
    const { token, challenge, salt, difficulty } = render.builtin!;
    // The raw challenge exposed in render must match the one signed in the token.
    expect(challenge).toBe(parseChallenge(token));
    // Client hashes the RAW challenge; echoes the TOKEN back in FIELD.challenge.
    const nonce = solvePow(challenge, salt, difficulty);
    const ok = await verifyCaptcha({ provider: "builtin" }, {
      [FIELD.challenge]: token,
      [FIELD.nonce]: nonce,
    });
    expect(ok).toEqual({ ok: true });
  });

  it("builtin façade rejects a missing nonce", async () => {
    const render = getClientRender({ provider: "builtin" });
    const r = await verifyCaptcha({ provider: "builtin" }, { [FIELD.challenge]: render.builtin!.token });
    expect(r.ok).toBe(false);
  });

  it("third-party providers fail closed when secret is missing", async () => {
    expect(await verifyCaptcha({ provider: "turnstile" }, { [FIELD.token]: "x" })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(await verifyCaptcha({ provider: "recaptcha" }, { [FIELD.token]: "x" })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });

  it("third-party providers reject a missing token even with a secret", async () => {
    expect(await verifyCaptcha({ provider: "turnstile", secret: "s" }, {})).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });
});

/**
 * The façade returns the SIGNED challenge token in `builtin.challenge`; the
 * raw `challenge` string the client hashes is recoverable by decoding the
 * token payload. We decode it here to drive the test solver.
 */
function parseChallenge(token: string): string {
  const dot = token.indexOf(".");
  const payloadB64 = token.slice(0, dot);
  const json = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json).c as string;
}
