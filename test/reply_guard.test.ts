// Guards for the double-writeHead crash: an unauthenticated GET /api/calendars
// used to kill the server outright (see src/lib/reply_guard.ts for the full
// mechanism). These predicates are the two safety nets — server.ts's error
// handler returns the reply untouched when replyAlreadySent(), and the
// process-level uncaughtException handler survives isBenignDoubleWrite().
//
// Scope note: the crash itself only manifests in the fully-wired app over a
// real socket — a stripped-down Fastify instance (with or without
// compress/cors/rate-limit, via inject or a real listener) does not reproduce
// it, so there is no honest end-to-end reproduction to assert here. What these
// tests pin is the decision logic both nets depend on: inverting either
// predicate, or narrowing isBenignDoubleWrite so a real double-write slips
// through as fatal, goes red.

import { describe, it, expect } from "vitest";
import { replyAlreadySent, isBenignDoubleWrite } from "../src/lib/reply_guard.js";

describe("replyAlreadySent", () => {
  it("is true once Fastify has sent, even while the onSend chain is in flight", () => {
    expect(replyAlreadySent({ sent: true, raw: { headersSent: false } })).toBe(true);
  });

  it("is true when something wrote to the socket directly (streaming / hijacked)", () => {
    expect(replyAlreadySent({ sent: false, raw: { headersSent: true } })).toBe(true);
  });

  it("is false for an untouched reply, so normal errors still render", () => {
    expect(replyAlreadySent({ sent: false, raw: { headersSent: false } })).toBe(false);
  });

  it("does not throw on a reply with no raw (defensive — error handlers must never throw)", () => {
    expect(replyAlreadySent({ sent: false })).toBe(false);
    expect(replyAlreadySent({})).toBe(false);
  });
});

describe("isBenignDoubleWrite", () => {
  it("recognises the double-writeHead error by code, whatever its message", () => {
    const err = Object.assign(new Error("Cannot write headers after they are sent to the client"), {
      code: "ERR_HTTP_HEADERS_SENT",
    });
    expect(isBenignDoubleWrite(err)).toBe(true);
  });

  it("recognises it on a bare object too (unhandledRejection reasons need not be Errors)", () => {
    expect(isBenignDoubleWrite({ code: "ERR_HTTP_HEADERS_SENT" })).toBe(true);
  });

  it("leaves every other failure fatal — unknown state must not be swallowed", () => {
    expect(isBenignDoubleWrite(new Error("boom"))).toBe(false);
    expect(isBenignDoubleWrite(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(isBenignDoubleWrite(Object.assign(new Error("x"), { code: "ERR_UNHANDLED_REJECTION" }))).toBe(false);
    // Message-only matches must NOT count: matching on prose would swallow
    // unrelated failures the moment someone words an error the same way.
    expect(isBenignDoubleWrite(new Error("Cannot write headers after they are sent to the client"))).toBe(false);
  });

  it("does not throw on null / undefined / primitives", () => {
    for (const v of [null, undefined, 0, "", "ERR_HTTP_HEADERS_SENT", false]) {
      expect(isBenignDoubleWrite(v)).toBe(false);
    }
  });
});
