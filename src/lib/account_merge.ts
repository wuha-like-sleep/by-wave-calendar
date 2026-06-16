// Admin tool: merge a duplicate account (source) into a target account.
//
// Strategy: reassign the source's user-owned CONTENT to the target, then delete
// the source. Deleting the source lets Postgres FK rules clean up everything
// else for free — sessions / devices / API tokens / passkeys / app-passwords /
// push subs / login history all `ON DELETE CASCADE`, and audit / invitedBy /
// createdBy references are `ON DELETE SET NULL`. So we only hand-move the things
// that should survive: calendars (which carry their events/attendees), booking
// links, calendar memberships, and SSO identities.
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve "email or uuid" to a user row, or null. */
export async function resolveUserRef(emailOrId: string): Promise<schema.User | null> {
  const v = (emailOrId || "").trim();
  if (!v) return null;
  if (UUID_RE.test(v)) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, v)).limit(1);
    if (u) return u;
  }
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, v.toLowerCase())).limit(1);
  return u ?? null;
}

export type MergeSummary = {
  calendars: number;
  events: number;
  bookingLinks: number;
  memberships: number;
  identities: number;
};

/** What would move if `sourceId` were merged away. Read-only (dry run). */
export async function mergeSummary(sourceId: string): Promise<MergeSummary> {
  const [cal] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.calendars)
    .where(eq(schema.calendars.ownerId, sourceId));
  const [ev] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.events.calendarId, schema.calendars.id))
    .where(eq(schema.calendars.ownerId, sourceId));
  const [bl] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.bookingLinks)
    .where(eq(schema.bookingLinks.userId, sourceId));
  const [mem] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.calendarMembers)
    .where(eq(schema.calendarMembers.userId, sourceId));
  const [idn] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.userIdentities)
    .where(eq(schema.userIdentities.userId, sourceId));
  return {
    calendars: cal?.c ?? 0,
    events: ev?.c ?? 0,
    bookingLinks: bl?.c ?? 0,
    memberships: mem?.c ?? 0,
    identities: idn?.c ?? 0,
  };
}

export type MergeResult = { ok: true; summary: MergeSummary } | { ok: false; error: string };

export async function mergeAccounts(sourceId: string, targetId: string): Promise<MergeResult> {
  if (sourceId === targetId) return { ok: false, error: "源账号和目标账号相同" };
  const [src] = await db.select().from(schema.users).where(eq(schema.users.id, sourceId)).limit(1);
  const [tgt] = await db.select().from(schema.users).where(eq(schema.users.id, targetId)).limit(1);
  if (!src) return { ok: false, error: "源账号不存在" };
  if (!tgt) return { ok: false, error: "目标账号不存在" };
  // Guard: never merge away an admin (could be an accident / privilege loss).
  if (src.isAdmin) return { ok: false, error: "源账号是管理员，出于安全不允许被合并（请先取消其管理员身份）" };

  const summary = await mergeSummary(sourceId);

  await db.transaction(async (tx) => {
    // 1. Calendars — carries events/attendees/exdates via calendarId.
    await tx.update(schema.calendars).set({ ownerId: targetId }).where(eq(schema.calendars.ownerId, sourceId));

    // 2. Booking links — unique (userId, slug); suffix colliding slugs.
    const targetSlugs = new Set(
      (await tx.select({ slug: schema.bookingLinks.slug }).from(schema.bookingLinks).where(eq(schema.bookingLinks.userId, targetId)))
        .map((r) => r.slug),
    );
    const srcLinks = await tx.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.userId, sourceId));
    for (const link of srcLinks) {
      let slug = link.slug;
      if (targetSlugs.has(slug)) slug = `${slug}-m${link.id.slice(0, 8)}`.slice(0, 31);
      await tx.update(schema.bookingLinks).set({ userId: targetId, slug }).where(eq(schema.bookingLinks.id, link.id));
      targetSlugs.add(slug);
    }

    // 3. Calendar memberships — unique (calendarId, userId); drop collisions.
    const targetCals = new Set(
      (await tx.select({ calendarId: schema.calendarMembers.calendarId }).from(schema.calendarMembers).where(eq(schema.calendarMembers.userId, targetId)))
        .map((r) => r.calendarId),
    );
    const srcMembers = await tx.select().from(schema.calendarMembers).where(eq(schema.calendarMembers.userId, sourceId));
    for (const m of srcMembers) {
      if (targetCals.has(m.calendarId)) {
        await tx.delete(schema.calendarMembers).where(eq(schema.calendarMembers.id, m.id));
      } else {
        await tx.update(schema.calendarMembers).set({ userId: targetId }).where(eq(schema.calendarMembers.id, m.id));
        targetCals.add(m.calendarId);
      }
    }

    // 4. SSO identities — global unique (provider, subject) → no collision.
    await tx.update(schema.userIdentities).set({ userId: targetId }).where(eq(schema.userIdentities.userId, sourceId));

    // 5. Delete the now-empty source. FK cascade/set-null cleans the rest.
    await tx.delete(schema.users).where(eq(schema.users.id, sourceId));
  });

  return { ok: true, summary };
}
