import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/event_cancel.js", () => ({ notifyEventCancellation: vi.fn(async () => ({ ok: true, cancelledNotices: 0 })) }));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { webRoutes } = await import("../../src/web/index.js");
const { bookingRoutes } = await import("../../src/routes/booking.js");
const { availableSlots, bookSlot, cancelBooking } = await import("../../src/lib/booking.js");
const { makeT } = await import("../../src/lib/i18n.js");
const { env } = await import("../../src/env.js");
const { jsonForScript } = await import("../../src/lib/script_json.js");
const { sendMail } = await import("../../src/lib/mailer.js");

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof makeUser>>;
let link: typeof schema.bookingLinks.$inferSelect;
let auth: string;
const pages: JSDOM[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });
function scriptedPage(html: string) {
  const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window) {
    const Native = Intl.DateTimeFormat;
    window.Intl.DateTimeFormat = function(locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return new Native(locale, { timeZone: "Asia/Shanghai", ...options });
    } as typeof Intl.DateTimeFormat;
  } });
  pages.push(dom); return dom;
}
const now = new Date("2026-11-15T16:30:00Z"); // Shanghai Monday, 00:30.

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);
  await app.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view", options: { async: false },
    defaultContext: {
      t: makeT("zh-CN"), siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
      assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n", currentLocale: "zh-CN",
      locales: [], siteLocaleOptions: [], currentUser: null, themePalette: "indigo",
      themeDensity: "comfortable", currentPath: "/book", jsonForScript,
    },
  });
  await app.register(webRoutes);
  await app.register(bookingRoutes, { prefix: "/api" });
  await app.ready();
});
afterAll(async () => { vi.useRealTimers(); await app.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await resetDb();
  owner = await makeUser("booking-owner@example.com");
  const cal = await makeCalendar(owner.id);
  await db.update(schema.calendars).set({ timezone: "Asia/Shanghai" }).where(eq(schema.calendars.id, cal.id));
  [link] = await db.insert(schema.bookingLinks).values({
    userId: owner.id, calendarId: cal.id, slug: "chat", title: "Booking experience",
    durationMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
    weeklyAvailability: { "1": [["01:00", "02:00"]], "2": [["01:00", "02:00"]] },
  }).returning() as [typeof schema.bookingLinks.$inferSelect];
  auth = await loginAs(app, owner.id);
});

async function page() {
  const res = await app.inject({ url: `/book/${owner.id}/${link.slug}` });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return res;
}
async function post(values: Record<string, string>, csrf?: string) {
  const token = csrf ?? new JSDOM((await page()).body).window.document.querySelector<HTMLInputElement>("[name=_csrf]")!.value;
  return app.inject({ method: "POST", url: `/book/${owner.id}/${link.slug}`,
    payload: { _csrf: token, ...values } });
}
async function reserve() {
  const slot = (await availableSlots(link, new Date(), 14))[0]!;
  return bookSlot({ link, ...slot, guestName: "Guest", guestEmail: "guest@example.com" });
}

describe("public booking experience", () => {
  it("keeps the advertised date and time consistent across visitor timezones", async () => {
    const response = await page();
    const dom = scriptedPage(response.body);
    const document = dom.window.document;
    expect(document.querySelector<HTMLButtonElement>("[data-date]")!.dataset.date).toBe("2026-11-16");
    expect(document.querySelector(".slot-btn")!.textContent).toBe("01:00");
    expect(response.headers["cache-control"]).toBe("no-store");
    dom.window.close();
  });

  it("keeps the chosen slot when clicking the current date and prevents duplicate submissions", async () => {
    const dom = scriptedPage((await page()).body);
    const document = dom.window.document;
    document.querySelector<HTMLButtonElement>(".slot-btn")!.click();
    const picked = document.querySelector<HTMLInputElement>("#picked-slot")!;
    const selected = picked.value;
    document.querySelector<HTMLButtonElement>(".date-btn")!.click();
    expect(picked.value).toBe(selected);
    expect(document.querySelector("#selected-slot-summary")!.textContent).toMatch(/01:00.*01:30/);
    expect(document.querySelector(".slot-btn")!.getAttribute("aria-pressed")).toBe("true");
    const form = document.querySelector<HTMLFormElement>("form")!;
    expect(form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }))).toBe(true);
    expect(form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }))).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#confirm-btn")!.disabled).toBe(true);
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    expect(document.querySelector<HTMLButtonElement>("#confirm-btn")!.disabled).toBe(false);
    dom.window.close();
  });

  it("preserves safe guest details and the valid selection after validation fails", async () => {
    const startsAt = (await availableSlots(link, new Date(), 14))[0]!.startsAt.toISOString();
    const response = await post({ startsAt, guestName: '<img src=x onerror="alert(1)">',
      guestEmail: "bad-email", guestMessage: "Keep this message" });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    const document = new JSDOM(response.body).window.document;
    expect(document.querySelector<HTMLInputElement>("[name=guestName]")!.value).toBe('<img src=x onerror="alert(1)">');
    expect(document.querySelector<HTMLInputElement>("[name=guestEmail]")!.value).toBe("bad-email");
    expect(document.querySelector<HTMLTextAreaElement>("[name=guestMessage]")!.value).toBe("Keep this message");
    expect(document.querySelector<HTMLInputElement>("#picked-slot")!.value).toBe(startsAt);
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(await db.select().from(schema.bookings)).toHaveLength(0);
  });

  it("refreshes occupied slots without discarding the guest's message", async () => {
    const created = await reserve();
    const response = await post({ startsAt: created.booking.startsAt.toISOString(), guestName: "Second guest",
      guestEmail: "second@example.com", guestMessage: "Important details" });
    expect(response.statusCode).toBe(409);
    const document = new JSDOM(response.body).window.document;
    expect(document.querySelector<HTMLInputElement>("#picked-slot")!.value).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>("[name=guestMessage]")!.value).toBe("Important details");
    expect(await db.select().from(schema.bookings)).toHaveLength(1);
  });

  it("trims guest data and redirects successful bookings without feedback in the URL", async () => {
    const startsAt = (await availableSlots(link, new Date(), 14))[0]!.startsAt.toISOString();
    const response = await post({ startsAt, guestName: "  Guest  ", guestEmail: "  guest@example.com  " });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/book/${owner.id}/${link.slug}`);
    const [booking] = await db.select().from(schema.bookings);
    expect(booking!.guestName).toBe("Guest");
    expect(booking!.guestEmail).toBe("guest@example.com");
  });

  it("retains guest details even when the contested slot was the last available slot", async () => {
    await db.update(schema.bookingLinks).set({ maxDaysAhead: 1, weeklyAvailability: { "1": [["01:00", "01:30"]] } })
      .where(eq(schema.bookingLinks.id, link.id));
    const token = new JSDOM((await page()).body).window.document.querySelector<HTMLInputElement>("[name=_csrf]")!.value;
    const created = await reserve();
    const response = await post({ startsAt: created.booking.startsAt.toISOString(), guestName: "Second guest",
      guestEmail: "second@example.com", guestMessage: "Keep my details" }, token);
    expect(response.statusCode).toBe(409);
    const document = scriptedPage(response.body).window.document;
    expect(document.querySelector<HTMLTextAreaElement>("[name=guestMessage]")!.value).toBe("Keep my details");
    expect(document.querySelectorAll(".slot-btn")).toHaveLength(0);
    expect(document.querySelector<HTMLButtonElement>("#confirm-btn")!.disabled).toBe(true);
  });

  it("renders booking titles as text in confirmation emails", async () => {
    const title = '<img src=x onerror="alert(1)"> A & B';
    await db.update(schema.bookingLinks).set({ title }).where(eq(schema.bookingLinks.id, link.id));
    const startsAt = (await availableSlots(link, new Date(), 14))[0]!.startsAt.toISOString();
    const response = await post({ startsAt, guestName: "Guest", guestEmail: "guest@example.com" });
    expect(response.statusCode).toBe(302);
    expect(vi.mocked(sendMail).mock.calls).toHaveLength(2);
    for (const [mail] of vi.mocked(sendMail).mock.calls) {
      expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; A &amp; B");
      expect(mail.html).not.toContain(title);
    }
  });

  it("shows the appointment date and time before cancelling it", async () => {
    const created = await reserve();
    const response = await app.inject({ url: `/book-cancel/${created.booking.cancelToken}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("2026年11月16日");
    expect(response.body).toContain("01:00");
    expect(response.body).toContain("01:30");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("booking notice timezone belongs to each recipient", () => {
  const startsAt = "2026-11-16T01:00:00.000Z"; // Host Melbourne 12:00, guest Shanghai 09:00.
  beforeEach(async () => {
    await db.update(schema.calendars).set({ timezone: "Australia/Melbourne" }).where(eq(schema.calendars.id, link.calendarId));
    await db.update(schema.bookingLinks).set({ weeklyAvailability: { "1": [["12:00", "13:00"]] } }).where(eq(schema.bookingLinks.id, link.id));
  });

  it("sends Melbourne 12:00 to the owner and Shanghai 09:00 to the guest without changing the event zone", async () => {
    const response = await post({ startsAt, guestName: "Guest", guestEmail: "guest@example.com", guestTimeZone: "Asia/Shanghai" });
    expect(response.statusCode).toBe(302);
    const mails = vi.mocked(sendMail).mock.calls.map(([mail]) => mail);
    const guest = mails.find(mail => mail.to === "guest@example.com")!, host = mails.find(mail => mail.to === owner.email)!;
    for (const value of [guest.text, guest.html]) { expect(value).toContain("09:00"); expect(value).toContain("Asia/Shanghai"); expect(value).not.toContain("Australia/Melbourne"); }
    for (const value of [host.text, host.html]) { expect(value).toContain("12:00"); expect(value).toContain("Australia/Melbourne"); expect(value).not.toContain("Asia/Shanghai"); }
    const [booking] = await db.select().from(schema.bookings), [event] = await db.select().from(schema.events);
    expect(booking!.startsAt.toISOString()).toBe(startsAt); expect(event!.startsAt.toISOString()).toBe(startsAt);
    expect(event!.extra).toMatchObject({ timezone: "Australia/Melbourne", bookingGuestTimeZone: "Asia/Shanghai" });
    const [calendar] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, link.calendarId));
    const [storedLink] = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.id, link.id));
    expect(calendar!.timezone).toBe("Australia/Melbourne");
    expect(storedLink!.weeklyAvailability).toEqual({ "1": [["12:00", "13:00"]] });
  });

  it("never interprets the guest display zone as authority to shift the host's availability", async () => {
    const response = await post({ startsAt: "2026-11-16T04:00:00.000Z", guestName: "Guest", guestEmail: "guest@example.com", guestTimeZone: "Asia/Shanghai" });
    expect(response.statusCode).toBe(409); // 12:00 Shanghai is 15:00 Melbourne, outside the host's hours.
    expect(await db.select().from(schema.bookings)).toHaveLength(0);
    expect(await db.select().from(schema.events)).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
    const document = new JSDOM(response.body).window.document;
    expect(document.querySelector<HTMLInputElement>("[name=guestName]")!.value).toBe("Guest");
    expect(document.querySelector<HTMLInputElement>("[name=guestTimeZone]")!.value).toBe("Asia/Shanghai");
  });

  it.each(["Invalid/Zone", "+08:00"])("rejects an invalid guest zone %s while retaining guest details", async (guestTimeZone) => {
    const response = await post({ startsAt, guestName: "Guest", guestEmail: "guest@example.com", guestMessage: "Keep this", guestTimeZone });
    expect(response.statusCode).toBe(400);
    const document = new JSDOM(response.body).window.document;
    expect(document.querySelector<HTMLInputElement>("[name=guestName]")!.value).toBe("Guest");
    expect(document.querySelector<HTMLTextAreaElement>("[name=guestMessage]")!.value).toBe("Keep this");
    expect(document.querySelector<HTMLInputElement>("#picked-slot")!.value).toBe(startsAt);
    expect(await db.select().from(schema.bookings)).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("accepts old forms without a guest zone and explicitly labels the host-zone fallback", async () => {
    const response = await post({ startsAt, guestName: "Guest", guestEmail: "guest@example.com" });
    expect(response.statusCode).toBe(302);
    const guest = vi.mocked(sendMail).mock.calls.find(([mail]) => mail.to === "guest@example.com")![0];
    expect(guest.text).toContain("12:00"); expect(guest.text).toContain("Australia/Melbourne");
  });

  it("canonicalizes a valid guest-zone alias without changing the source timezone", async () => {
    const response = await post({ startsAt, guestName: "Guest", guestEmail: "guest@example.com", guestTimeZone: "PRC" });
    expect(response.statusCode).toBe(302);
    const [event] = await db.select().from(schema.events);
    expect(event!.extra).toMatchObject({ timezone: "Australia/Melbourne", bookingGuestTimeZone: "Asia/Shanghai" });
  });
});

describe("booking management safeguards", () => {
  it("keeps active bookings and their cancel tokens when a link deletion is attempted", async () => {
    const created = await reserve();
    const response = await app.inject({ method: "DELETE", url: `/api/booking-links/${link.id}`, headers: { cookie: auth } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("active_bookings");
    expect(await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.id, link.id))).toHaveLength(1);
    expect(await cancelBooking(created.booking.cancelToken)).toEqual({ found: true, alreadyCancelled: false });
    const deleted = await app.inject({ method: "DELETE", url: `/api/booking-links/${link.id}`, headers: { cookie: auth } });
    expect(deleted.statusCode).toBe(200);
  });

  it.each(["0", "false"])("all=%s does not unexpectedly show cancelled bookings", async (all) => {
    const created = await reserve();
    await cancelBooking(created.booking.cancelToken);
    const response = await app.inject({ url: `/api/booking-links/${link.id}/bookings?all=${all}`, headers: { cookie: auth } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    const history = await app.inject({ url: `/api/booking-links/${link.id}/bookings?all=1`, headers: { cookie: auth } });
    expect(history.json()).toHaveLength(1);
  });
});
