import { beforeAll, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
import { db, ensureSchema, schema } from "./harness.js";
import { pruneWebhookDeliveries } from "../../src/lib/webhooks.js";
import { eq, asc } from "drizzle-orm";

beforeAll(ensureSchema);
it("retains the newest 1000 deliveries independently for each webhook", async () => {
  const hooks = await db.insert(schema.webhooks).values([
    { label: "busy", url: "https://example.com/busy" },
    { label: "quiet", url: "https://example.com/quiet" },
  ]).returning();
  await db.insert(schema.webhookDeliveries).values(Array.from({ length: 1002 }, (_, i) => ({
    webhookId: hooks[0]!.id, eventName: `event-${i}`, createdAt: new Date(1_700_000_000_000 + i * 1000),
  })));
  await db.insert(schema.webhookDeliveries).values({ webhookId: hooks[1]!.id, eventName: "keep-me" });
  await pruneWebhookDeliveries();
  const retained = await db.select().from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.webhookId, hooks[0]!.id)).orderBy(asc(schema.webhookDeliveries.createdAt));
  expect(retained).toHaveLength(1000);
  expect(retained[0]!.eventName).toBe("event-2");
  expect(retained.at(-1)!.eventName).toBe("event-1001");
  const quiet = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, hooks[1]!.id));
  expect(quiet.map((row) => row.eventName)).toEqual(["keep-me"]);
});
