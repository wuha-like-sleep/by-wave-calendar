import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ values: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/db/client.js", () => ({
  db: { insert: () => ({ values: mocks.values }) }, schema: { webhookDeliveries: {} },
}));
vi.mock("../src/lib/ssrf_guard.js", () => ({ safeFetch: mocks.fetch }));
import { dispatchTestWebhook } from "../src/lib/webhooks.js";
import type { Webhook } from "../src/db/schema.js";

const hook = { id: "hook", url: "https://receiver.example.com", secret: "secret" } as Webhook;
beforeEach(() => { mocks.values.mockReset().mockResolvedValue(undefined); mocks.fetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

it("cancels an endless receiver body and records a bounded successful delivery", async () => {
  let pulls = 0;
  const cancel = vi.fn();
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024).fill(65)); }, cancel,
  })));
  // Old text()-then-slice behaviour would never complete on this stream.
  await dispatchTestWebhook(hook);
  expect(cancel).toHaveBeenCalledOnce();
  expect(pulls).toBeLessThanOrEqual(5);
  expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
    ok: true, statusCode: 200, responseBody: "A".repeat(1024), attemptCount: 1,
  }));
});

it("preserves UTF-8 split across chunks and records HTTP failures", async () => {
  const text = "接收失败";
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    for (const byte of Buffer.from(text)) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { status: 400 }));
  await dispatchTestWebhook(hook);
  expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ ok: false, statusCode: 400, responseBody: text }));
});
