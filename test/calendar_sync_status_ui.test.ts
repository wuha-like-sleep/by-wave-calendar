import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const source = readFileSync("src/public/js/calendar-sync-status.js", "utf8");
const pages: JSDOM[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });
function mount() {
  const page = new JSDOM('<div data-microsoft-unconfigured></div><form data-microsoft-connect hidden><button disabled>Connect</button></form><select><option selected value="draft">Draft calendar selection</option></select>', { url: "https://calendar.test/app/settings/calendar-sync", runScripts: "outside-only", pretendToBeVisual: true }); pages.push(page);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ microsoftConfigured: true }) });
  page.window.fetch = fetcher; page.window.AbortSignal.timeout = AbortSignal.timeout;
  page.window.eval(source); return { page, fetcher };
}
describe("calendar connection configuration refresh", () => {
  it("updates controls on return to the page without losing selected calendars", async () => {
    const { page, fetcher } = mount(); page.window.dispatchEvent(new page.window.Event("focus"));
    await vi.waitFor(() => expect(page.window.document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false));
    expect(fetcher).toHaveBeenCalledWith('/app/settings/calendar-sync/status', expect.objectContaining({ cache: 'no-store', redirect: 'error', credentials: 'same-origin' }));
    expect(page.window.document.querySelector<HTMLElement>('[data-microsoft-unconfigured]')!.hidden).toBe(true);
    expect(page.window.document.querySelector<HTMLSelectElement>('select')!.value).toBe('draft');
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ microsoftConfigured: false }) });
    page.window.dispatchEvent(new page.window.Event('focus'));
    await vi.waitFor(() => expect(page.window.document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true));
    expect(page.window.document.querySelector<HTMLElement>('[data-microsoft-connect]')!.hidden).toBe(true);
  });
  it("keeps the last known state on failures or malformed responses", async () => {
    const { page, fetcher } = mount();
    fetcher.mockRejectedValue(new Error('offline')); page.window.dispatchEvent(new page.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(page.window.document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ microsoftConfigured: 'yes' }) }); page.window.dispatchEvent(new page.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(page.window.document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });
});
