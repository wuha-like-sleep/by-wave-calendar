import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import ejs from "ejs";
import { afterEach, describe, expect, it } from "vitest";
import { makeT, clientStrings } from "../src/lib/i18n.js";
import { jsonForScript } from "../src/lib/script_json.js";
import { listTimezones } from "../src/lib/timezones.js";
import "../src/public/calendar-app.js";

const source = readFileSync(new URL("../src/public/calendar-app.js", import.meta.url), "utf8");
const time = (globalThis as any).bwcEventTime;
const start = "2026-11-28T01:00:12.345Z", end = "2026-11-28T02:00:12.345Z";
const event = { id: "e1", calendarId: "c1", summary: "Melbourne meeting", startsAt: start, endsAt: end, allDay: false, extra: { timezone: "Australia/Melbourne", endTimezone: undefined } };
const calendars = [{ id: "c1", name: "Melbourne", timezone: "Australia/Melbourne", color: "#3366ff", description: "" }];
const pages: JSDOM[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });

async function page(fixture: any = event, initialZone = "Asia/Shanghai", store = false, at?: string) {
  let zone = initialZone;
  const writes: any[] = [];
  const html = ejs.render(readFileSync(new URL("../src/views/app/calendar-app.ejs", import.meta.url), "utf8"), {
    user: { isAdmin: false }, t: makeT("en"), currentLocale: "en", jsonForScript, calendars, publicBaseUrl: "https://calendar.invalid", csrfToken: "fake",
    timezones: listTimezones("en"), jsStrings: clientStrings("en"), cspNonce: "fake",
  }).replace(/<script\b[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "https://calendar.invalid/app?event=e1&cal=c1", runScripts: "outside-only", pretendToBeVisual: true });
  pages.push(dom);
  const w = dom.window as any;
  if (at) w.Date.now = () => Date.parse(at);
  w.__bwc = { calendars, csrfToken: "fake" }; w.BWC_LOCALE = "en"; w.BWC_T = clientStrings("en"); w.bwcTimezones = listTimezones("en");
  w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  w.CSS = { escape: (value: string) => value };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.bwc = { confirm: async () => true, toast() {} };
  const Native = Intl.DateTimeFormat;
  w.Intl.DateTimeFormat = function(locale: any, options: any = {}) { return new Native(locale, { timeZone: zone, ...options }); };
  const handlers = new Map();
  class Calendar {
    options: any; events: any[] = []; anchor = new Date(start);
    constructor(_selector: string, options: any) { this.options = options; w.calendar = this; }
    on(name: string, callback: any) { handlers.set(name, callback); }
    clear() {} render() {} setCalendars() {} setTheme() {} setCalendarVisibility() {}
    getDate() { return { toDate: () => this.anchor }; }
    getDateRangeStart() { return { toDate: () => new Date("2026-11-23T00:00:00Z") }; }
    getDateRangeEnd() { return { toDate: () => new Date("2026-11-29T00:00:00Z") }; }
    createEvents(events: any[]) { this.events = events; }
    setDate(date: Date) { this.anchor = new Date(date); }
    setOptions(options: any) { this.options = { ...this.options, ...options }; }
    changeView() {} today() {} prev() {} next() {} clearGridSelections() {}
  }
  w.tui = { Calendar };
  w.fetch = async (url: string, options: any = {}) => {
    if (options.method === "PATCH" || options.method === "POST" && !String(url).includes("conflicts")) writes.push({ url, body: JSON.parse(options.body) });
    const data = String(url).includes("eventId=") ? [fixture] : String(url).includes("conflicts") ? { conflicts: [] } : String(url).startsWith("/api/events?") ? { events: [fixture] } : [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
  };
  if (store) w.bwcStore = { getAll: async () => ({ events: [fixture] }), put: async (body: any, calendarId: string, base: any) => { writes.push({ body, calendarId, base }); }, isOnline: () => true, on() {}, onChange() {}, pendingCount: async () => 0, listConflicts: async () => [] };
  w.eval(source);
  await new Promise(resolve => setTimeout(resolve, 30));
  const form = w.document.querySelector("#form-event") as HTMLFormElement;
  return { w, form, writes, handlers, setZone(next: string) { zone = next; w.dispatchEvent(new w.Event("focus")); },
    async save() { (w.document.querySelector("#btn-enter-edit") as HTMLButtonElement).click(); (form.elements.namedItem("summary") as HTMLInputElement).value = "Changed title"; form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 30)); } };
}

describe("browser calendar time semantics", () => {
  it("uses calendar fallback for one source zone and omits redundant same-zone/all-day conversion", () => {
    expect(time.zones({ extra: {} }, "Australia/Melbourne", "Asia/Shanghai").source).toBe("Australia/Melbourne");
    expect(time.zones(event, null, "Australia/Melbourne").source).toBeNull();
    expect(time.zones({ ...event, allDay: true }, null, "Asia/Shanghai").source).toBeNull();
    expect(time.zones({ ...event, extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } }, null, "UTC")).toMatchObject({ source: null, itinerary: true });
  });
  it("preserves milliseconds and both possible DST instants, rejects gaps, and handles half-hour folds", () => {
    expect(time.inputValue(start, "Asia/Shanghai")).toBe("2026-11-28T09:00:12.345");
    const folds = time.localCandidates("2026-11-01T01:30:00.123", "America/New_York");
    expect(folds.map((d: Date) => d.toISOString())).toEqual(["2026-11-01T05:30:00.123Z", "2026-11-01T06:30:00.123Z"]);
    expect(time.resolveInput("2026-11-01T01:30:00.123", "America/New_York", folds[1]).toISOString()).toBe("2026-11-01T06:30:00.123Z");
    expect(time.localCandidates("2026-03-08T02:30", "America/New_York")).toEqual([]);
    expect(time.localCandidates("2026-04-05T01:45", "Australia/Lord_Howe").map((d: Date) => d.toISOString())).toEqual(["2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"]);
    expect(time.range("2026-11-01T05:45:00Z", "2026-11-01T06:15:00Z", "America/New_York", "en")).toMatch(/GMT-4.*GMT-5/);
  });
  it("keeps both all-day formats on the same civil dates and ends past styling at local midnight", () => {
    for (const end of ["2026-11-29T00:00:00Z", "2026-11-28T23:59:59.999Z"]) {
      const allDay = { allDay: true, startsAt: "2026-11-28T00:00:00Z", endsAt: end };
      expect(time.allDayDates(allDay.startsAt, end)).toEqual({ start: "2026-11-28", end: "2026-11-28" });
      expect(new Date(time.pastEnd(allDay, "America/Los_Angeles")).toISOString()).toBe("2026-11-29T08:00:00.000Z");
      expect(new Date(time.pastEnd(allDay, "Asia/Shanghai")).toISOString()).toBe("2026-11-28T16:00:00.000Z");
    }
    expect(new Date(time.pastEnd({ allDay: true, startsAt: "2011-12-29T00:00:00Z", endsAt: "2011-12-30T00:00:00Z" }, "Pacific/Apia")).toISOString()).toBe("2011-12-30T10:00:00.000Z");
  });
  it("renders browser 09:00 and Melbourne 12:00, complete end time, and saves title without endpoints/source", async () => {
    const p = await page();
    expect((p.form.elements.namedItem("startsAt") as HTMLInputElement).value).toBe("2026-11-28T09:00:12.345");
    expect(p.w.document.querySelector("#tz-hint").textContent).toMatch(/Melbourne.*12:00.*13:00/);
    expect(p.w.calendar.options.template.time(p.w.calendar.events[0])).toMatch(/09:00.*10:00.*Melbourne.*12:00.*13:00/);
    await p.save();
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
    expect(p.writes[0].body.extra).not.toHaveProperty("timezone"); expect(p.writes[0].body.extra).not.toHaveProperty("endTimezone");
  });
  it("preserves legacy calendar-derived zone on title-only edit and supplies a complete offline cache base", async () => {
    const p = await page({ ...event, extra: {} }, "Asia/Shanghai", true);
    expect((p.form.elements.namedItem("timezone") as HTMLInputElement).value).toBe("Australia/Melbourne");
    await p.save();
    expect(p.writes[0].body.extra).not.toHaveProperty("timezone");
    expect(p.writes[0].base.startsAt).toBe(start); expect(p.writes[0].base.endsAt).toBe(end);
  });
  it("keeps a second-fold event exact and exposes an explicit offset choice", async () => {
    const fixture = { ...event, startsAt: "2026-11-01T06:30:00.123Z", endsAt: "2026-11-01T07:00:00.456Z", extra: { timezone: "America/New_York" } };
    const p = await page(fixture, "America/New_York");
    expect((p.form.elements.namedItem("startsAtFold") as HTMLInputElement).value).toBe(fixture.startsAt);
    expect(p.w.document.querySelector('[name="startsAtFold"]').options).toHaveLength(2);
    await p.save();
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
  });
  it.each(["2026-11-29T00:00:00Z", "2026-11-28T23:59:59.999Z"])("does not extend or shift all-day dates on open/title edit: %s", async endsAt => {
    const p = await page({ ...event, allDay: true, startsAt: "2026-11-28T00:00:00Z", endsAt }, "America/Los_Angeles");
    expect((p.form.elements.namedItem("startsAtDate") as HTMLInputElement).value).toBe("2026-11-28");
    expect((p.form.elements.namedItem("endsAtDate") as HTMLInputElement).value).toBe("2026-11-28");
    expect(p.w.calendar.events[0].end).toBe("2026-11-28");
    expect(p.w.document.querySelector("#event-elapsed").classList.contains("hidden")).toBe(true);
    expect(p.w.document.querySelector("#duration-chips").classList.contains("hidden")).toBe(true);
    await p.save();
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
  });
  it("keeps source/end zones and instants when the device zone changes during a draft", async () => {
    const fixture = { ...event, startsAt: "2026-11-28T12:00:00Z", endsAt: "2026-11-28T21:00:00Z", extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } };
    const p = await page(fixture);
    expect(p.w.document.querySelector("#tz-hint").textContent).toMatch(/Departure.*23:00.*Arrival.*05:00/);
    p.setZone("America/Los_Angeles");
    expect(p.form.dataset.displayTimeZone).toBe("America/Los_Angeles");
    await p.save();
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
    expect(p.writes[0].body.extra).not.toHaveProperty("endTimezone");
  });
  it.each([
    ["2026-11-28T12:00:00Z", "2026-11-28T21:00:00Z", "9 hours"],
    ["2026-07-01T13:00:00Z", "2026-07-01T21:00:00Z", "8 hours"],
  ])("shows actual trip duration in read-only details: %s → %s", async (startsAt, endsAt, duration) => {
    const p = await page({ ...event, startsAt, endsAt, extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } });
    const elapsed = p.w.document.querySelector("#event-elapsed");
    expect(elapsed.classList.contains("hidden")).toBe(false);
    expect(elapsed.querySelector("[data-elapsed-value]").textContent).toBe(duration);
    expect(p.w.document.querySelector("#duration-chips").classList.contains("hidden")).toBe(true);
    expect(p.w.document.querySelector("#event-quick-fill").classList.contains("hidden")).toBe(true);
    p.w.document.querySelector("#btn-enter-edit").click();
    expect(elapsed.classList.contains("hidden")).toBe(true);
    expect(p.w.document.querySelector("#duration-chips").classList.contains("hidden")).toBe(false);
    expect(p.w.document.querySelector("#event-quick-fill").classList.contains("hidden")).toBe(false);
    expect(time.elapsed(startsAt, new Date(Date.parse(startsAt) + (26 * 60 + 15) * 60000), "en")).toBe("26 hours 15 minutes");
  });
  it("creates Melbourne 23:00 to Shanghai next-day 05:00 through the real editor", async () => {
    const p = await page();
    p.w.document.querySelector("#btn-new-event").click();
    const fields = p.form.elements as any;
    expect(fields.timezone.value).toBe("Australia/Melbourne");
    fields.startsAt.value = "2026-11-28T23:00";
    fields.startsAt.dispatchEvent(new p.w.Event("change"));
    fields.separateEndTimeZone.click();
    fields.endTimezone.value = "Asia/Shanghai";
    fields.endTimezone.dispatchEvent(new p.w.Event("change"));
    fields.endsAt.value = "2026-11-29T05:00";
    fields.endsAt.dispatchEvent(new p.w.Event("input"));
    await p.save();
    expect(p.writes[0].body).toMatchObject({ startsAt: "2026-11-28T12:00:00.000Z", endsAt: "2026-11-28T21:00:00.000Z", extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } });
    expect(Date.parse(p.writes[0].body.endsAt) - Date.parse(p.writes[0].body.startsAt)).toBe(9 * 3600000);
  });
  it("pins a legacy source when only the destination is changed", async () => {
    const p = await page({ ...event, extra: {} });
    p.w.document.querySelector("#btn-enter-edit").click();
    const fields = p.form.elements as any;
    fields.separateEndTimeZone.click();
    fields.endTimezone.value = "Asia/Shanghai";
    fields.endTimezone.dispatchEvent(new p.w.Event("change"));
    expect(fields.startsAt.value).toBe("2026-11-28T12:00:12.345");
    expect(fields.endsAt.value).toBe("2026-11-28T10:00:12.345");
    await p.save();
    expect(p.writes[0].body.extra).toMatchObject({ timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" });
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
  });
  it("restores destination following with explicit null while keeping both instants", async () => {
    const p = await page({ ...event, extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } });
    p.w.document.querySelector("#btn-enter-edit").click();
    const fields = p.form.elements as any;
    fields.separateEndTimeZone.click();
    expect(fields.endsAt.value).toBe("2026-11-28T13:00:12.345");
    await p.save();
    expect(p.writes[0].body.extra.endTimezone).toBeNull();
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
  });
  it("changing the source zone preserves instants and re-renders both following endpoints", async () => {
    const p = await page();
    p.w.document.querySelector("#btn-enter-edit").click();
    const fields = p.form.elements as any;
    fields.timezone.value = "Asia/Tokyo";
    fields.timezone.dispatchEvent(new p.w.Event("change"));
    expect(fields.startsAt.value).toBe("2026-11-28T10:00:12.345");
    expect(fields.endsAt.value).toBe("2026-11-28T11:00:12.345");
    await p.save();
    expect(p.writes[0].body.extra.timezone).toBe("Asia/Tokyo");
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
  });
  it("round-trips timed/all-day civil dates without changing a trip's exact instants", async () => {
    const fixture = { ...event, startsAt: "2026-11-28T12:00:00.123Z", endsAt: "2026-11-28T21:00:00.456Z", extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } };
    const p = await page(fixture);
    p.w.document.querySelector("#btn-enter-edit").click();
    const fields = p.form.elements as any;
    fields.allDay.click();
    expect(fields.startsAtDate.value).toBe("2026-11-28"); expect(fields.endsAtDate.value).toBe("2026-11-29");
    fields.allDay.click();
    expect(fields.startsAt.value).toBe("2026-11-28T23:00:00.123"); expect(fields.endsAt.value).toBe("2026-11-29T05:00:00.456");
    await p.save();
    expect(p.writes[0].body).not.toHaveProperty("startsAt"); expect(p.writes[0].body).not.toHaveProperty("endsAt");
  });
  it("rejects a nonexistent local time without silently moving it forward", async () => {
    const p = await page({ ...event, startsAt: "2026-03-08T06:30:00Z", endsAt: "2026-03-08T08:30:00Z", extra: { timezone: "America/New_York" } });
    p.w.document.querySelector("#btn-enter-edit").click();
    const fields = p.form.elements as any;
    fields.startsAt.value = "2026-03-08T02:30";
    fields.startsAt.dispatchEvent(new p.w.Event("input"));
    expect(fields.startsAt.validationMessage).toContain("does not exist");
    await p.save();
    expect(p.writes).toHaveLength(0);
    expect(fields.startsAt.value).toBe("2026-03-08T02:30");
  });

  it("uses local civil bounds for the all-day next-event banner, including DST", async () => {
    const fixture = { ...event, allDay: true, startsAt: "2026-11-28T00:00:00Z", endsAt: "2026-11-29T00:00:00Z" };
    const afterLocalMidnight = await page(fixture, "Asia/Shanghai", false, "2026-11-28T17:00:00Z");
    expect(afterLocalMidnight.w.document.querySelector("#next-event-banner").classList.contains("hidden")).toBe(true);
    const duringLocalDay = await page(fixture, "America/Los_Angeles", false, "2026-11-29T02:00:00Z");
    expect(duringLocalDay.w.document.querySelector("#next-event-banner").classList.contains("hidden")).toBe(false);
    const spring = time.eventBounds({ allDay: true, startsAt: "2026-03-08T00:00:00Z", endsAt: "2026-03-09T00:00:00Z" }, "America/New_York");
    const autumn = time.eventBounds({ allDay: true, startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-02T00:00:00Z" }, "America/New_York");
    expect(spring.end - spring.start).toBe(23 * 3600000);
    expect(autumn.end - autumn.start).toBe(25 * 3600000);
  });

  it("labels cities neutrally and uses the event date's offset in both endpoint pickers", async () => {
    const p = await page({ ...event, startsAt: "2026-07-01T01:00:00Z", endsAt: "2026-07-01T02:00:00Z" });
    p.w.document.querySelector("#btn-enter-edit").click();
    const origin = p.w.document.querySelector("#event-origin-zone");
    expect(origin.textContent).toContain("GMT+10:00");
    expect(origin.textContent).not.toContain("DST");
    origin.querySelector("[data-tz-trigger]").click();
    const ny = p.w.document.querySelector('[data-tz-pick="America/New_York"]');
    expect(ny.textContent).toContain("GMT-04:00");
    expect(ny.textContent).not.toContain("DST");
    for (const locale of ["zh-CN", "zh-TW", "en", "de", "fr", "ja", "ko", "es"] as const) {
      const city = listTimezones(locale).find(zone => zone.id === "America/New_York")!;
      expect(city.label).not.toMatch(/DST|夏令|夏時間|Sommerzeit|heure d'été|verano|서머타임/);
    }
    const fold = await page({ ...event, startsAt: "2026-11-01T06:30:00Z", endsAt: "2026-11-01T07:00:00Z", extra: { timezone: "America/New_York" } }, "America/New_York");
    fold.w.document.querySelector("#btn-enter-edit").click();
    expect(fold.w.document.querySelector("#event-origin-zone").textContent).toContain("GMT-05:00");
    expect(fold.w.document.querySelector("#event-origin-zone").textContent).not.toContain("DST");
  });

});
