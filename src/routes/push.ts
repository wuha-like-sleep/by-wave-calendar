// Web Push subscription management. Three endpoints:
//
// GET  /api/push/public-key  — frontend needs this to call PushManager.subscribe
// POST /api/push/subscribe   — register a new (endpoint, p256dh, auth) tuple
// POST /api/push/unsubscribe — remove by endpoint (called when user revokes)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
import { getPublicVapidKey } from "../lib/push.js";

export async function pushRoutes(app: FastifyInstance) {
  app.get("/push/public-key", async (_req, reply) => {
    const key = await getPublicVapidKey();
    return reply.send({ publicKey: key });
  });

  app.post("/push/subscribe", async (req, reply) => {
    const user = await requireUser(req, reply);
    const body = z.object({
      endpoint: z.string().url().max(2048),
      keys: z.object({
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
      }),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    // Upsert by endpoint. If the same endpoint was previously registered
    // by another user (rare but possible if two users share a browser),
    // we overwrite — the most recent subscription wins.
    const existing = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, body.data.endpoint)).limit(1);
    const userAgent = String(req.headers["user-agent"] ?? "").slice(0, 500) || null;
    if (existing.length > 0) {
      await db.update(schema.pushSubscriptions).set({
        userId: user.id,
        p256dh: body.data.keys.p256dh,
        auth: body.data.keys.auth,
        userAgent,
      }).where(eq(schema.pushSubscriptions.endpoint, body.data.endpoint));
    } else {
      await db.insert(schema.pushSubscriptions).values({
        userId: user.id,
        endpoint: body.data.endpoint,
        p256dh: body.data.keys.p256dh,
        auth: body.data.keys.auth,
        userAgent,
      });
    }
    return reply.send({ ok: true });
  });

  app.post("/push/unsubscribe", async (req, reply) => {
    const user = await requireUser(req, reply);
    const body = z.object({ endpoint: z.string().url().max(2048) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await db.delete(schema.pushSubscriptions).where(and(
      eq(schema.pushSubscriptions.endpoint, body.data.endpoint),
      eq(schema.pushSubscriptions.userId, user.id),
    ));
    return reply.send({ ok: true });
  });
}
