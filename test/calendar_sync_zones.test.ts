import { describe, expect, it, vi } from "vitest";
import { MicrosoftClient, microsoftItem, SOURCE_ZONE_PROPERTY } from "../src/lib/calendar_sync/microsoft.js";
import { acknowledgedContent, acknowledgeLink, decide, emptyState, linkSchema, type SyncContent, type SyncItem } from "../src/lib/calendar_sync/model.js";
import { synchronize, type SyncSide } from "../src/lib/calendar_sync/engine.js";
import { microsoftSourceZone, unambiguousWallTime } from "../src/lib/calendar_sync/zones.js";
const content: SyncContent = { summary: "Meeting", description: "", location: "", startsAt: "2026-11-28T13:30:00.000Z", endsAt: "2026-11-28T14:30:00.000Z", allDay: false };
const graphEvent = { id: "e", changeKey: "v", subject: "Meeting", body: { contentType: "text", content: "" }, start: { dateTime: "2026-11-28T13:30:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-28T14:30:00.0000000", timeZone: "UTC" }, isAllDay: false };
const item = (id: string, changes: Partial<SyncContent> = {}): SyncItem => ({ id, revision: id, content: { ...content, ...changes } });

describe("system calendar source zones", () => {
  it("reads original Outlook zones, never the UTC response preference", () => {
    const event = microsoftItem({ ...graphEvent, originalStartTimeZone: "AUS Eastern Standard Time", originalEndTimeZone: "China Standard Time" });
    expect(event.content).toMatchObject({ startsAt: content.startsAt, endsAt: content.endsAt, timezone: "Australia/Sydney", endTimezone: "Asia/Shanghai" });
    expect(microsoftItem(graphEvent).content.timezone).toBeUndefined();
    expect(microsoftSourceZone("tzone://Microsoft/Custom")).toBeUndefined();
    expect(() => microsoftItem({ ...graphEvent, start: { dateTime: "2026-11-29T00:30:00", timeZone: "Australia/Melbourne" } })).toThrow("microsoft_utc_response_required");
  });
  it("converts supported source clocks once and preserves exact UTC instants in returned content", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("supportedTimeZones") ?
      Response.json({ value: [{ alias: "Australia/Sydney" }, { alias: "Asia/Shanghai" }] }) :
      Response.json({ ...graphEvent, originalStartTimeZone: "AUS Eastern Standard Time", originalEndTimeZone: "China Standard Time" }));
    const result = await new MicrosoftClient("fake", fetcher).save("c", { ...content, timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" });
    const write = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(String(write[1]!.body))).toMatchObject({ start: { dateTime: "2026-11-29T00:30:00.000", timeZone: "Australia/Sydney" }, end: { dateTime: "2026-11-28T22:30:00.000", timeZone: "Asia/Shanghai" } });
    expect(result.content.startsAt).toBe(content.startsAt); expect(result.content.endsAt).toBe(content.endsAt);
    expect(result.content.timezone).toBe("Australia/Melbourne"); expect(result.content.endTimezone).toBe("Asia/Shanghai");
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("supportedTimeZones"))).toHaveLength(1);
  });
  it("title-only Outlook writes leave date zones, description and location properties untouched", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...graphEvent, subject: "Changed", originalStartTimeZone: "AUS Eastern Standard Time", originalEndTimeZone: "AUS Eastern Standard Time" }));
    await new MicrosoftClient("fake", fetcher).save("c", { ...content, summary: "Changed", timezone: "Australia/Melbourne", endTimezone: null }, item("e", { timezone: "Australia/Sydney", endTimezone: null }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ subject: "Changed" });
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ "If-Match": "e" });
  });
  it("uses precise UTC with source metadata for a verified restricted mailbox, but never bypasses lookup failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes("supportedTimeZones") ? Response.json({ value: [{ alias: "UTC" }] }) :
      Response.json({ ...graphEvent, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC" }));
    const created = await new MicrosoftClient("fake", fetcher).save("c", { ...content, timezone: "Australia/Melbourne", endTimezone: null });
    expect(created.content).toMatchObject({ ...content, timezone: "Australia/Melbourne", endTimezone: null });
    const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body));
    expect(body.start).toEqual({ dateTime: "2026-11-28T13:30:00.000", timeZone: "UTC" });
    expect(body.singleValueExtendedProperties[0].id).toBe(SOURCE_ZONE_PROPERTY);
    const unavailable = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    await expect(new MicrosoftClient("fake", unavailable).save("c", { ...content, timezone: "Australia/Melbourne" })).rejects.toThrow("microsoft_reconnect");
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable.mock.calls[0]![1]!.method).toBe("GET");
  });
  it.each([
    ["America/New_York", "2026-11-01T06:30:00.123Z", "2026-11-01T07:30:00.123Z"],
    ["Australia/Lord_Howe", "2026-04-04T15:15:00.789Z", "2026-04-04T15:25:00.789Z"],
  ])("preserves precise instants and source zones through %s folds without blocking writes", async (zone, start, end) => {
    expect(unambiguousWallTime(start, zone)).toBeNull();
    let remote = { ...graphEvent, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", singleValueExtendedProperties: [] as Array<{ id: string; value: string }> };
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes("supportedTimeZones")) return Response.json({ value: [{ alias: zone }] });
      if (options?.method === "POST" || options?.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        if (body.start) { remote.start = body.start; remote.originalStartTimeZone = body.start.timeZone; }
        if (body.end) { remote.end = body.end; remote.originalEndTimeZone = body.end.timeZone; }
        if (body.singleValueExtendedProperties) remote.singleValueExtendedProperties = body.singleValueExtendedProperties;
        if (body.subject) remote.subject = body.subject;
      }
      // The fixture's end is also in the fold, except NY's 02:30. Model
      // Graph's UTC response preference separately from its native zones.
      const { fromWallClock } = await import("../src/lib/zoned_time.js");
      const utc = (point: { dateTime: string; timeZone: string }) => ({ dateTime: (point.timeZone === "UTC" ? new Date(point.dateTime + "Z") : fromWallClock(new Date(point.dateTime + "Z"), point.timeZone)).toISOString().replace(/Z$/, ""), timeZone: "UTC" });
      return Response.json({ ...remote, start: utc(remote.start), end: utc(remote.end) });
    });
    const client = new MicrosoftClient("fake", fetcher);
    const source = { ...content, startsAt: start, endsAt: end, timezone: zone, endTimezone: null };
    const created = await client.save("c", source);
    expect(created.content).toMatchObject(source);
    expect(remote.start.timeZone).toBe("UTC");
    expect(remote.singleValueExtendedProperties[0]!.id).toBe(SOURCE_ZONE_PROPERTY);
    const loaded = (await client.get("c", created.id))!;
    expect(loaded.content).toMatchObject(source);
    expect(decide({ leftId: "l", rightId: loaded.id, base: source }, item("l", source), loaded)).toBe("equal");
    const shifted = { ...source, startsAt: new Date(new Date(start).getTime() + 60000).toISOString() };
    const updated = await client.save("c", shifted, loaded);
    expect(updated.content).toMatchObject(shifted);
    expect((await client.get("c", updated.id))!.content).toMatchObject(shifted);
    const title = await client.save("c", { ...shifted, summary: "Next update still runs" }, updated);
    expect(title.content.timezone).toBe(zone);
    const lastWrite = fetcher.mock.calls.filter(([, options]) => options?.method === "PATCH").at(-1)!;
    expect(JSON.parse(String(lastWrite[1]!.body))).toEqual({ subject: "Next update still runs" });
    // A native UTC transport time edit must not masquerade as an intentional
    // source-zone change when the old property no longer matches its instant.
    const stale = microsoftItem({ ...graphEvent, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", singleValueExtendedProperties: remote.singleValueExtendedProperties });
    expect(stale.content.timezone).toBeUndefined();
  });
  it("legacy baselines do not turn historical UTC mirrors into source-zone edits", () => {
    const left = item("l", { timezone: "Australia/Melbourne", endTimezone: null });
    const right = item("r", { timezone: "UTC", endTimezone: null });
    const link = { leftId: "l", rightId: "r", base: content };
    for (let pass = 0; pass < 3; pass++) {
      expect(decide(link, left, right)).toBe("equal");
      link.base = acknowledgedContent(link.base, left.content, right.content);
      expect(link.base.timezone).toBeUndefined();
    }
  });
  it("keeps valid native non-UTC zones when a native time edit invalidates an exact-city binding", () => {
    const metadata = { startsAt: "2026-11-28T12:30:00.000Z", endsAt: "2026-11-28T13:30:00.000Z", timezone: "America/New_York", endTimezone: "America/New_York", utcStart: false, utcEnd: false };
    const value = microsoftItem({ ...graphEvent, originalStartTimeZone: "Eastern Standard Time", originalEndTimeZone: "Eastern Standard Time", singleValueExtendedProperties: [{ id: SOURCE_ZONE_PROPERTY, value: JSON.stringify(metadata) }] });
    expect(value.content).toMatchObject({ timezone: "America/New_York", endTimezone: null, startsAt: content.startsAt, endsAt: content.endsAt });
  });
  it("known zone edits synchronize, aliases do not conflict, and unknown metadata never clears a source", () => {
    const base = { ...content, timezone: "Australia/Melbourne", endTimezone: null };
    const link = { leftId: "l", rightId: "r", base };
    expect(decide(link, item("l", base), item("r", { timezone: "Asia/Shanghai", endTimezone: null }))).toBe("to-left");
    expect(decide(link, item("l", base), item("r", { timezone: "Australia/Sydney", endTimezone: null }))).toBe("equal");
    expect(decide(link, item("l", base), item("r"))).toBe("equal");
    expect(acknowledgedContent({ ...content, endTimezone: "Asia/Shanghai" }, content, { ...content, endTimezone: null }).endTimezone).toBeNull();
  });
  it("a zone-only edit on either side of a legacy UTC mirror survives a restart", () => {
    const left = item("left", { ...content, timezone: "Australia/Melbourne" });
    const right = item("right", { ...content, timezone: "UTC" });
    const link = linkSchema.parse({ leftId: left.id, rightId: right.id, base: content });
    acknowledgeLink(link, left.content, right.content);
    const restored = linkSchema.parse(JSON.parse(JSON.stringify(link)));
    expect(decide(restored, left, right)).toBe("equal");
    const tokyo = { ...left, content: { ...left.content, timezone: "Asia/Tokyo" } };
    const paris = { ...right, content: { ...right.content, timezone: "Europe/Paris" } };
    expect(decide(restored, tokyo, right)).toBe("to-right");
    expect(decide(restored, left, paris)).toBe("to-left");
    expect(decide(restored, tokyo, paris)).toBe("conflict");
    acknowledgeLink(restored, tokyo.content, tokyo.content);
    expect(restored.base.timezone).toBe("Asia/Tokyo");
    expect(restored.legacyZones).toBeUndefined();
  });
  it("a legacy remote title edit preserves ByWave source and reaches a stable checkpoint", async () => {
    let local = item("l", { timezone: "Australia/Melbourne", endTimezone: null });
    const remote = item("r", { summary: "Changed", timezone: "UTC", endTimezone: null });
    const save = vi.fn(async (value: SyncContent) => local = { ...local, content: { ...local.content, ...value } });
    const left: SyncSide = { snapshot: async () => new Map([[local.id, local]]), save, remove: vi.fn() };
    const right: SyncSide = { snapshot: async () => new Map([[remote.id, remote]]), save: vi.fn(), remove: vi.fn() };
    const state = emptyState(); state.links.push({ leftId: "l", rightId: "r", base: content });
    for (let pass = 0; pass < 3; pass++) expect(await synchronize("p", state, left, right, async () => {}, async () => {})).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1); expect(local.content).toMatchObject({ summary: "Changed", timezone: "Australia/Melbourne" });
  });
});
