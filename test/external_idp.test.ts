import { describe, it, expect } from "vitest";
import {
  stripSlash,
  parseClientList,
  isUuid,
  tokenClientIds,
  decideTarget,
} from "../src/lib/external_idp.js";

describe("stripSlash", () => {
  it("trims trailing slashes", () => {
    expect(stripSlash("https://kc/realms/x/")).toBe("https://kc/realms/x");
    expect(stripSlash("https://kc/realms/x")).toBe("https://kc/realms/x");
  });
});

describe("parseClientList", () => {
  it("splits on commas/whitespace and trims", () => {
    const s = parseClientList("meeting-platform, svc-b  svc-c,");
    expect([...s].sort()).toEqual(["meeting-platform", "svc-b", "svc-c"]);
  });
  it("empty/null → empty set", () => {
    expect(parseClientList("").size).toBe(0);
    expect(parseClientList(null).size).toBe(0);
  });
});

describe("isUuid", () => {
  it("matches canonical UUIDs only", () => {
    expect(isUuid("13f8dac1-3f25-4ad8-b27f-b5027cfa9dec")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("user@example.com")).toBe(false);
  });
});

describe("tokenClientIds", () => {
  it("collects azp + aud (string or array)", () => {
    expect(tokenClientIds({ azp: "cli", aud: "account" }).sort()).toEqual(["account", "cli"]);
    expect(tokenClientIds({ aud: ["a", "b"] }).sort()).toEqual(["a", "b"]);
    expect(tokenClientIds({})).toEqual([]);
  });
});

describe("decideTarget (security model)", () => {
  it("service client may target any account via X-Account", () => {
    expect(decideTarget({ isServiceClient: true, emailClaim: null, accountHeader: "u@x.com" }))
      .toEqual({ target: "u@x.com" });
  });
  it("service client with no header falls back to its email claim", () => {
    expect(decideTarget({ isServiceClient: true, emailClaim: "Svc@X.com", accountHeader: null }))
      .toEqual({ target: "svc@x.com" });
  });
  it("service client with neither → error", () => {
    expect(decideTarget({ isServiceClient: true, emailClaim: null, accountHeader: null }))
      .toEqual({ error: "x_account_required" });
  });
  it("user token binds to its own email, ignores matching header", () => {
    expect(decideTarget({ isServiceClient: false, emailClaim: "Me@X.com", accountHeader: "me@x.com" }))
      .toEqual({ target: "me@x.com" });
    expect(decideTarget({ isServiceClient: false, emailClaim: "me@x.com", accountHeader: null }))
      .toEqual({ target: "me@x.com" });
  });
  it("user token REJECTS a different-account X-Account (no privilege escalation)", () => {
    expect(decideTarget({ isServiceClient: false, emailClaim: "me@x.com", accountHeader: "victim@x.com" }))
      .toEqual({ error: "x_account_not_allowed" });
    expect(decideTarget({ isServiceClient: false, emailClaim: "me@x.com", accountHeader: "13f8dac1-3f25-4ad8-b27f-b5027cfa9dec" }))
      .toEqual({ error: "x_account_not_allowed" });
  });
  it("user token with no email claim → error", () => {
    expect(decideTarget({ isServiceClient: false, emailClaim: null, accountHeader: null }))
      .toEqual({ error: "no_email_claim" });
  });
});
