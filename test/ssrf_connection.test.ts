import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createPublicAddressLookup, safeFetch, isBlockedAddress, validateOutboundUrl } from "../src/lib/ssrf_guard.js";

const lookupAll = lookup as unknown as (host: string, options: { all: true }) => Promise<LookupAddress[]>;
beforeEach(() => { vi.mocked(lookupAll).mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

it.each(["/next.ics", "http://[invalid"])("cancels an unbounded redirect body before following %s", async (location) => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } });
  const fetchMock = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response("calendar"));
  vi.stubGlobal("fetch", fetchMock);
  const request = safeFetch("http://127.0.0.1/feed.ics", { allowPrivate: true });
  if (location.startsWith("/")) {
    expect(await (await request).text()).toBe("calendar");
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1/next.ics");
  } else {
    await expect(request).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  }
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels a redirect body when the redirect limit is reached", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
    status: 302, headers: { location: "/next.ics" },
  })));
  await expect(safeFetch("http://127.0.0.1/feed.ics", { allowPrivate: true, maxRedirects: 0 })).rejects.toThrow(/重定向/);
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects DNS rebinding between URL validation and the actual socket connection", async () => {
  vi.mocked(lookupAll)
    .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  await expect(safeFetch("http://rebinding.example.com/feed.ics")).rejects.toThrow();
  // A second lookup really happened in the connection resolver. There is no
  // listener at the private target: the request must stop before connecting.
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("returns the vetted public addresses directly to the socket", async () => {
  const records = [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }];
  vi.mocked(lookupAll).mockResolvedValueOnce(records);
  const addresses = await new Promise((resolve, reject) => {
    createPublicAddressLookup()("example.com", { all: true }, (error, result) => error ? reject(error) : resolve(result));
  });
  expect(addresses).toEqual(records);
  expect(lookup).toHaveBeenCalledOnce();
});

it("rejects a mixed public/private DNS answer at connection time", async () => {
  vi.mocked(lookupAll).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  await expect(new Promise((resolve, reject) => {
    createPublicAddressLookup()("example.com", {}, (error, result) => error ? reject(error) : resolve(result));
  })).rejects.toThrow(/内网/);
});

it("normalizes expanded IPv6 and keeps bracketed public addresses usable", async () => {
  expect(isBlockedAddress("0:0:0:0:0:0:0:1")).toBe(true);
  expect(isBlockedAddress("0:0:0:0:0:0:0:0")).toBe(true);
  expect(isBlockedAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
  expect((await validateOutboundUrl("https://[2606:4700:4700::1111]/feed.ics")).hostname).toBe("[2606:4700:4700::1111]");
  expect(lookup).not.toHaveBeenCalled();
});
