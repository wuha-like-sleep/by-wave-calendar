import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
import { newShareToken } from "../lib/ids.js";
import { env } from "../env.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(100).optional(),
});

const updateSchema = createSchema.partial();

const idParam = z.object({ id: z.string().uuid() });

export async function calendarRoutes(app: FastifyInstance) {
  app.get("/api/calendars", async (req, reply) => {
    const user = await requireUser(req, reply);
    const rows = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id))
      .orderBy(desc(schema.calendars.createdAt));
    return reply.send(rows);
  });

  app.post("/api/calendars", async (req, reply) => {
    const user = await requireUser(req, reply);
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(schema.calendars)
      .values({ ownerId: user.id, ...body })
      .returning();
    return reply.code(201).send(row);
  });

  app.patch("/api/calendars/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const [row] = await db
      .update(schema.calendars)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(schema.calendars.id, id), eq(schema.calendars.ownerId, user.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.send(row);
  });

  app.delete("/api/calendars/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const result = await db
      .delete(schema.calendars)
      .where(and(eq(schema.calendars.id, id), eq(schema.calendars.ownerId, user.id)))
      .returning({ id: schema.calendars.id });
    if (result.length === 0) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ok: true });
  });

  app.get("/api/calendars/:id/share-tokens", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const owned = await ownsCalendar(id, user.id);
    if (!owned) return reply.code(404).send({ error: "not_found" });
    const tokens = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.calendarId, id), isNull(schema.shareTokens.revokedAt)));
    return reply.send(tokens.map((t) => ({ ...t, url: subscribeUrl(t.token) })));
  });

  app.post("/api/calendars/:id/share-tokens", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const body = z.object({ label: z.string().max(100).optional() }).parse(req.body ?? {});
    const owned = await ownsCalendar(id, user.id);
    if (!owned) return reply.code(404).send({ error: "not_found" });
    const token = newShareToken();
    const [row] = await db
      .insert(schema.shareTokens)
      .values({ token, calendarId: id, label: body.label })
      .returning();
    if (!row) return reply.code(500).send({ error: "insert_failed" });
    return reply.code(201).send({ ...row, url: subscribeUrl(row.token) });
  });

  app.delete("/api/calendars/:id/share-tokens/:token", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id, token } = z.object({ id: z.string().uuid(), token: z.string() }).parse(req.params);
    const owned = await ownsCalendar(id, user.id);
    if (!owned) return reply.code(404).send({ error: "not_found" });
    const result = await db
      .update(schema.shareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareTokens.token, token), eq(schema.shareTokens.calendarId, id)))
      .returning({ token: schema.shareTokens.token });
    if (result.length === 0) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ok: true });
  });
}

async function ownsCalendar(calendarId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

function subscribeUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/ics/${token}.ics`;
}
