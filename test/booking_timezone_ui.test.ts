import { readFileSync } from "node:fs";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { makeT } from "../src/lib/i18n.js";
import { jsonForScript } from "../src/lib/script_json.js";

const pages: JSDOM[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });
const slot = (startsAt: string) => ({ startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString() });
function page(template: "public" | "cancel", slots = [slot("2026-11-17T01:00:00Z")], host = "Asia/Shanghai", initialDevice = "America/Los_Angeles") {
  let device = initialDevice;
  const html = ejs.render(readFileSync(new URL(`../src/views/booking/${template}.ejs`, import.meta.url), "utf8"), {
    t: makeT("en"), currentLocale: "en", jsonForScript, cspNonce: "local", csrfToken: "fake", bookingZone: host,
    owner: { displayName: "Example host" }, link: { title: "Appointment", durationMinutes: 30, userId: "host", slug: "chat" },
    slotsByDate: [{ date: "2026-11-17", slots }], formValues: { guestName: "Example guest" },
    booking: { cancelledAt: null, guestName: "Example guest", guestEmail: "guest@example.invalid", cancelToken: "fake", startsAt: new Date(slots[0]!.startsAt), endsAt: new Date(slots[0]!.endsAt) },
  });
  const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window) {
    const Native = Intl.DateTimeFormat;
    window.Intl.DateTimeFormat = function(locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return new Native(locale, { timeZone: device, ...options });
    } as typeof Intl.DateTimeFormat;
  } });
  pages.push(dom);
  return { window: dom.window, document: dom.window.document, setDevice: (zone: string) => { device = zone; dom.window.dispatchEvent(new dom.window.Event("focus")); } };
}
describe("booking timezone presentation", () => {
  it("uses the visitor's date and time instead of the host's date at midnight boundaries", () => {
    const p = page("public");
    expect(p.document.querySelector<HTMLButtonElement>(".date-btn")!.dataset.date).toBe("2026-11-16");
    expect(p.document.querySelector(".slot-btn")!.textContent).toBe("17:00");
    expect(p.document.querySelector("#booking-zone-note")!.textContent).toContain("America/Los_Angeles");
    expect(p.document.querySelector<HTMLInputElement>("[name=guestTimeZone]")!.value).toBe("America/Los_Angeles");
  });
  it("keeps the exact selected instant and guest fields when switching to the host zone or changing device zone", () => {
    const p = page("public");
    p.document.querySelector<HTMLButtonElement>(".slot-btn")!.click();
    const chosen = p.document.querySelector<HTMLInputElement>("#picked-slot")!;
    const instant = chosen.value;
    const select = p.document.querySelector<HTMLSelectElement>("#booking-timezone")!;
    select.value = "host"; select.dispatchEvent(new p.window.Event("change"));
    expect(p.document.querySelector(".slot-btn")!.textContent).toBe("09:00");
    expect(p.document.querySelector<HTMLInputElement>("[name=guestTimeZone]")!.value).toBe("Asia/Shanghai");
    expect(chosen.value).toBe(instant);
    expect(p.document.querySelector<HTMLButtonElement>(".date-btn")!.dataset.date).toBe("2026-11-17");
    select.value = "device"; select.dispatchEvent(new p.window.Event("change"));
    p.setDevice("Pacific/Auckland");
    expect(p.document.querySelector(".slot-btn")!.textContent).toBe("14:00");
    expect(chosen.value).toBe(instant);
    expect(p.document.querySelector<HTMLInputElement>("[name=guestName]")!.value).toBe("Example guest");
    expect(p.document.querySelector("#selected-slot-summary")!.textContent).toContain("Pacific/Auckland");
    expect(p.document.querySelector<HTMLInputElement>("[name=guestTimeZone]")!.value).toBe("Pacific/Auckland");
  });
  it("submits a per-visitor display zone while preserving the host's 12:00 booking instant", () => {
    const p = page("public", [slot("2026-11-17T01:00:00Z")], "Australia/Melbourne", "Asia/Shanghai");
    p.document.querySelector<HTMLButtonElement>(".slot-btn")!.click();
    expect(p.document.querySelector(".slot-btn")!.textContent).toBe("09:00");
    const form = p.document.querySelector<HTMLFormElement>("#booking-form")!;
    form.dispatchEvent(new p.window.Event("submit", { cancelable: true }));
    const data = new p.window.FormData(form);
    expect(data.get("guestTimeZone")).toBe("Asia/Shanghai");
    expect(data.get("startsAt")).toBe("2026-11-17T01:00:00Z");
  });
  it("distinguishes the two instants in a daylight-saving repeated hour", () => {
    const p = page("public", [slot("2026-11-01T05:30:00Z"), slot("2026-11-01T06:30:00Z")], "America/New_York", "America/New_York");
    const buttons = [...p.document.querySelectorAll<HTMLButtonElement>(".slot-btn")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).not.toBe(buttons[1]!.textContent);
    expect(buttons[0]!.textContent).toContain("EDT"); expect(buttons[1]!.textContent).toContain("EST");
    buttons[1]!.click();
    expect(p.document.querySelector<HTMLInputElement>("#picked-slot")!.value).toBe("2026-11-01T06:30:00Z");
  });
  it("converts cancellation details too and follows device changes while open", () => {
    const p = page("cancel");
    expect(p.document.querySelector("#booking-cancel-time")!.textContent).toContain("17:00");
    expect(p.document.querySelector("#booking-zone-note")!.textContent).toContain("America/Los_Angeles");
    p.setDevice("Asia/Tokyo");
    expect(p.document.querySelector("#booking-cancel-time")!.textContent).toContain("10:00");
    expect(p.document.querySelector("#booking-zone-note")!.textContent).toContain("Asia/Tokyo");
  });
});
