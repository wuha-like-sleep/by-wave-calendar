import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { ensureSchema, resetDb, makeUser } from "./harness.js";
import { linkIdentity, findUserIdByIdentity, unlinkIdentity, listIdentities } from "../../src/lib/identities.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

describe("identities", () => {
  it("links, finds, lists, and unlinks", async () => {
    const u = await makeUser("u@x.com");
    expect(await linkIdentity({ userId: u.id, provider: "kc", subject: "s1", email: "u@x.com" })).toEqual({ ok: true, created: true });
    expect(await findUserIdByIdentity("kc", "s1")).toBe(u.id);

    const list = await listIdentities(u.id);
    expect(list.length).toBe(1);
    expect(await unlinkIdentity(u.id, list[0]!.id)).toBe(true);
    expect(await findUserIdByIdentity("kc", "s1")).toBeNull();
  });

  it("re-linking the same identity to the same user is idempotent (created:false)", async () => {
    const u = await makeUser("u@x.com");
    await linkIdentity({ userId: u.id, provider: "kc", subject: "s1", email: null });
    expect(await linkIdentity({ userId: u.id, provider: "kc", subject: "s1", email: null })).toEqual({ ok: true, created: false });
    expect((await listIdentities(u.id)).length).toBe(1);
  });

  it("refuses to link an identity already owned by another account", async () => {
    const a = await makeUser("a@x.com");
    const b = await makeUser("b@x.com");
    await linkIdentity({ userId: a.id, provider: "kc", subject: "shared", email: null });
    expect(await linkIdentity({ userId: b.id, provider: "kc", subject: "shared", email: null })).toEqual({ ok: false, reason: "linked_to_other" });
  });

  it("unlink only removes the caller's own identity (no cross-account delete)", async () => {
    const a = await makeUser("a@x.com");
    const b = await makeUser("b@x.com");
    await linkIdentity({ userId: a.id, provider: "kc", subject: "sa", email: null });
    const [aIdentity] = await listIdentities(a.id);
    expect(await unlinkIdentity(b.id, aIdentity!.id)).toBe(false);
    expect((await listIdentities(a.id)).length).toBe(1);
  });
});
