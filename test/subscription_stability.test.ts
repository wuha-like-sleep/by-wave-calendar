import { expect, it, vi } from "vitest";
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
import { makeSubscriptionTick, readLimitedIcsBody } from "../src/lib/ics_import.js";

it("does not overlap refresh batches and resumes after the first completes", async () => {
  let finish!: () => void;
  const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const warn = vi.fn();
  const tick = makeSubscriptionTick({ warn }, refresh);
  const first = tick();
  await tick();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  finish();
  await first;
  const next = tick();
  expect(refresh).toHaveBeenCalledTimes(2);
  finish();
  await next;
});

it("releases the refresh guard after a failure", async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const warn = vi.fn();
  const tick = makeSubscriptionTick({ warn }, refresh);
  await tick();
  await tick();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("rejects declared oversized downloads before consuming the stream", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(6 * 1024 * 1024) } });
  await expect(readLimitedIcsBody(response)).rejects.toThrow(/文件过大/);
  expect(cancel).toHaveBeenCalledOnce();
});

it("stops chunked downloads at the size limit even with a false content-length", async () => {
  const cancel = vi.fn();
  let chunks = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel,
  }), { headers: { "content-length": "1" } });
  await expect(readLimitedIcsBody(response)).rejects.toThrow(/文件过大/);
  expect(cancel).toHaveBeenCalledOnce();
  expect(chunks).toBeLessThanOrEqual(7);
});

it("keeps a valid UTF-8 calendar intact across chunk boundaries", async () => {
  const data = Buffer.from("BEGIN:VCALENDAR\r\nX-WR-CALNAME:日历\r\nEND:VCALENDAR");
  const response = new Response(new ReadableStream({ start(controller) {
    for (const value of data) controller.enqueue(new Uint8Array([value]));
    controller.close();
  } }));
  expect(await readLimitedIcsBody(response)).toEqual(data);
});
