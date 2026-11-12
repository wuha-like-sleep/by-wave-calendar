import { describe, it, expect, vi, afterEach } from "vitest";
import { synchronize, type SyncSide } from "../src/lib/calendar_sync/engine.js";
import { contentSchema, decide, emptyState, stableTransactionId, type SyncContent, type SyncItem, type SyncState } from "../src/lib/calendar_sync/model.js";
import { MicrosoftClient, graphUrl, microsoftItem } from "../src/lib/calendar_sync/microsoft.js";
import { parseDesktopManifest } from "../src/lib/desktop_release.js";
import { appleCalendarProfile } from "../src/lib/calendar_sync/apple_profile.js";
const content: SyncContent = { summary: "Plan", description: "", location: "", startsAt: "2026-11-13T09:00:00.000Z", endsAt: "2026-11-13T10:00:00.000Z", allDay: false };
const item = (id: string, summary = "Plan"): SyncItem => ({ id, revision: id + summary, content: { ...content, summary } });
function side(initial: SyncItem[] = []) {
  const rows = new Map(initial.map(i => [i.id, i])); let sequence = 0;
  const api: SyncSide = {
    snapshot: vi.fn(async () => new Map(rows)),
    findOrigin: vi.fn(async origin => [...rows.values()].find(x => x.origin === origin) ?? null),
    save: vi.fn(async (value, current, origin) => {
      const existing = current ?? [...rows.values()].find(x => x.origin === origin);
      const next = { id: existing?.id ?? "new" + ++sequence, revision: "r" + ++sequence, content: value, origin };
      rows.set(next.id, next); return next;
    }),
    remove: vi.fn(async value => { rows.delete(value.id); }),
  };
  return { ...api, rows };
}
const linked = (): SyncState => ({ ...emptyState(), links: [{ leftId: "a", rightId: "b", base: content }] });
const run = (state: SyncState, a: SyncSide, b: SyncSide, checkpoint = async (_: SyncState) => {}) => synchronize("pair", state, a, b, checkpoint, async () => {});
afterEach(() => vi.restoreAllMocks());
describe("three-way synchronization", () => {
  it("copies new appointments in either direction without loops", async () => {
    const a = side([item("a")]), b = side([item("b", "Other")]), state = emptyState();
    await run(state, a, b); await run(state, a, b);
    expect(state.links).toHaveLength(2); expect(a.rows.size).toBe(2); expect(b.rows.size).toBe(2);
    expect(a.save).toHaveBeenCalledTimes(1); expect(b.save).toHaveBeenCalledTimes(1);
  });
  it.each(["left", "right"] as const)("propagates a %s edit", async direction => {
    const a = side([item("a", direction === "left" ? "Edited" : "Plan")]);
    const b = side([item("b", direction === "right" ? "Edited" : "Plan")]);
    const state = linked(); expect(await run(state, a, b)).toEqual([]);
    expect([...a.rows.values()][0]!.content.summary).toBe("Edited"); expect([...b.rows.values()][0]!.content.summary).toBe("Edited");
    expect(state.links[0]!.base.summary).toBe("Edited");
  });
  it.each(["left", "right"] as const)("propagates an unchanged counterpart's %s deletion", async direction => {
    const a = side(direction === "left" ? [] : [item("a")]), b = side(direction === "right" ? [] : [item("b")]), state = linked();
    await run(state, a, b); expect(a.rows.size + b.rows.size).toBe(0); expect(state.links).toHaveLength(0);
  });
  it("preserves simultaneous edits and edit versus delete", async () => {
    const a = side([item("a", "Left edit")]), b = side([item("b", "Right edit")]);
    expect(await run(linked(), a, b)).toHaveLength(1);
    expect(await run(linked(), a, side())).toHaveLength(1);
    expect(a.save).not.toHaveBeenCalled(); expect(b.save).not.toHaveBeenCalled(); expect(a.remove).not.toHaveBeenCalled();
  });
  it("only resolves the exact revisions the user reviewed", async () => {
    const a = side([item("a", "Left edit")]), b = side([item("b", "Right edit")]), state = linked();
    state.resolutions.a = { side: "left", leftRevision: "stale", rightRevision: "bRight edit" };
    expect(await run(state, a, b)).toHaveLength(1);
    state.resolutions.a.leftRevision = "aLeft edit";
    expect(await run(state, a, b)).toHaveLength(0); expect(b.rows.get("b")!.content.summary).toBe("Left edit");
  });
  it("records an intent before creating and recovers a lost response", async () => {
    const a = side([item("a")]), b = side(), state = emptyState(); let persisted = emptyState();
    const original = b.save;
    b.save = async (...args) => { await original(...args); throw new Error("connection reset after commit"); };
    await expect(run(state, a, b, async s => { persisted = structuredClone(s); })).rejects.toThrow("connection reset");
    expect(persisted.pending?.sourceId).toBe("a");
    b.save = original; await run(persisted, a, b);
    expect(b.rows.size).toBe(1); expect(original).toHaveBeenCalledTimes(1); expect(persisted.pending).toBeUndefined();
  });
  it("recovers a created item that moved outside the snapshot window", async () => {
    const a = side([item("a")]), b = side([{ ...item("moved", "Edited"), origin: stableTransactionId("pair", "a") }]);
    b.snapshot = async () => new Map();
    const state = emptyState(); state.pending = { side: "left", sourceId: "a", origin: stableTransactionId("pair", "a"), content };
    await run(state, a, b); expect(b.save).not.toHaveBeenCalled(); expect(a.rows.get("a")!.content.summary).toBe("Edited");
  });
  it("recovers a creation deleted before its checkpoint without resurrecting it", async () => {
    const a = side(), b = side([item("b")]), state = emptyState();
    a.findOrigin = async () => ({ deletedId: "deleted" });
    state.pending = { side: "right", sourceId: "b", origin: "outlook:pending", content };
    await run(state, a, b);
    expect(a.save).not.toHaveBeenCalled(); expect(b.rows.size).toBe(0); expect(state.pending).toBeUndefined();
    const edited = side([item("b", "Edited")]);
    const next = emptyState(); next.pending = { side: "right", sourceId: "b", origin: "outlook:pending", content };
    expect(await run(next, a, edited)).toHaveLength(1); expect(edited.remove).not.toHaveBeenCalled();
  });
  it("does not write anything when the second snapshot fails", async () => {
    const a = side(), b = side(); b.snapshot = async () => { throw new Error("page 2 unavailable"); };
    await expect(run(linked(), a, b)).rejects.toThrow(); expect(a.remove).not.toHaveBeenCalled(); expect(b.remove).not.toHaveBeenCalled();
  });
  it("acknowledges identical edits without writing and forgets matching deletions", () => {
    const link = linked().links[0]!; expect(decide(link, item("a", "Same"), item("b", "Same"))).toBe("equal"); expect(decide(link, undefined, undefined)).toBe("forget");
  });
});
describe("Graph transport and dates", () => {
  const event = { id: "e", changeKey: "v1", subject: "Title", body: { contentType: "text", content: "Notes" }, start: { dateTime: "2026-11-13T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-13T10:00:00.0000000", timeZone: "UTC" }, isAllDay: false };
  it("accepts only Microsoft Graph me links", () => {
    for (const url of ["https://evil.example/v1.0/me", "https://graph.microsoft.com/v1.0/meevil", "https://x@graph.microsoft.com/v1.0/me", "https://graph.microsoft.com/v1.0/users/other"]) expect(() => graphUrl(url)).toThrow();
    expect(graphUrl("/me/calendars")).toBe("https://graph.microsoft.com/v1.0/me/calendars");
  });
  it("rejects an injected pagination destination before sending credentials", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": "https://evil.example/steal" }));
    await expect(new MicrosoftClient("secret", fetcher).pages("/me/calendars")).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects repeated and incomplete pages", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars" }));
    await expect(new MicrosoftClient("secret", fetcher).pages("/me/calendars")).rejects.toThrow("incomplete_snapshot");
    await expect(new MicrosoftClient("secret", async () => Response.json({ error: {} })).pages("/me/calendars")).rejects.toThrow();
  });
  it("makes conditional writes and handles a competing editor", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 412 }));
    await expect(new MicrosoftClient("secret", fetcher).save("c", content, item("e"))).rejects.toThrow("sync_conflict");
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ "If-Match": "ePlan" }); expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("requires calendar access before interpreting missing events", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(new MicrosoftClient("secret", fetcher).snapshot("c", content.startsAt, content.endsAt, ["e"])).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("normalizes timestamps and preserves all-day civil dates", () => {
    expect(microsoftItem(event).content.startsAt).toBe(content.startsAt);
    expect(microsoftItem({ ...event, isAllDay: true, end: { dateTime: "2026-11-14T00:00:00", timeZone: "UTC" } }).content.startsAt).toBe("2026-11-13T00:00:00.000Z");
    expect(() => contentSchema.parse({ ...content, endsAt: "bad" })).toThrow();
    expect(() => contentSchema.parse({ ...content, endsAt: content.startsAt })).toThrow();
  });
  it("refetches all-day events in their original zone", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const zone = (options?.headers as Record<string, string>).Prefer;
      return Response.json({ ...event, isAllDay: true, originalStartTimeZone: "AUS Eastern Standard Time", start: { dateTime: zone?.includes('timezone="UTC"') ? "2026-11-12T13:00:00" : "2026-11-13T00:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-14T00:00:00", timeZone: "UTC" } });
    });
    const result = await new MicrosoftClient("secret", fetcher).get("c", "e"); expect(result!.content.startsAt).toBe("2026-11-13T00:00:00.000Z"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe("Apple account settings", () => {
  it("uses a stable account identity, escapes XML and never embeds a password", () => {
    const user = { id: "u", email: 'one&two@example.com' };
    const profile = appleCalendarProfile("https://calendar.example:8443", user);
    expect(profile).toContain('one&amp;two@example.com'); expect(profile).toContain('<integer>8443</integer>');
    expect(profile).not.toContain("CalDAVPassword"); expect(profile).toBe(appleCalendarProfile("https://calendar.example:8443", user));
    expect(profile).toContain('/caldav/principals/u/');
  });
  it.each(["http://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com/?secret=x"])("rejects unsafe base %s", url => {
    expect(() => appleCalendarProfile(url, { id: "u", email: "a@b.com" })).toThrow();
  });
});

describe("desktop architecture manifests", () => {
  it("keeps Intel and Apple Silicon assets separate", () => {
    const release = parseDesktopManifest({ versionCode: 26, versionName: "1.2.0", assets: {
      mac: { filename: "arm64.dmg" }, macIntel: { filename: "intel.dmg" },
    } }, "2026-11-13");
    expect(release?.assets.mac?.filename).toBe("arm64.dmg");
    expect(release?.assets.macIntel?.filename).toBe("intel.dmg");
    expect(release?.assets.win).toBeUndefined();
  });
});
