import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type CalendarRole = "owner" | "editor" | "viewer";

export async function getUserRole(calendarId: string, userId: string): Promise<CalendarRole | null> {
  const [cal] = await db
    .select({ ownerId: schema.calendars.ownerId })
    .from(schema.calendars)
    .where(eq(schema.calendars.id, calendarId))
    .limit(1);
  if (!cal) return null;
  if (cal.ownerId === userId) return "owner";
  const [mem] = await db
    .select({ role: schema.calendarMembers.role })
    .from(schema.calendarMembers)
    .where(and(
      eq(schema.calendarMembers.calendarId, calendarId),
      eq(schema.calendarMembers.userId, userId),
    ))
    .limit(1);
  if (!mem) return null;
  return (mem.role === "editor" || mem.role === "viewer") ? mem.role : "viewer";
}

export async function canView(calendarId: string, userId: string): Promise<boolean> {
  return (await getUserRole(calendarId, userId)) !== null;
}

export async function canEdit(calendarId: string, userId: string): Promise<boolean> {
  const role = await getUserRole(calendarId, userId);
  return role === "owner" || role === "editor";
}

export async function isOwner(calendarId: string, userId: string): Promise<boolean> {
  return (await getUserRole(calendarId, userId)) === "owner";
}

export async function listVisibleCalendarIds(userId: string): Promise<string[]> {
  // Calendars owned OR shared (member).
  const owned = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(eq(schema.calendars.ownerId, userId));
  const shared = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .innerJoin(schema.calendarMembers, eq(schema.calendarMembers.calendarId, schema.calendars.id))
    .where(eq(schema.calendarMembers.userId, userId));
  return [...new Set([...owned.map((r) => r.id), ...shared.map((r) => r.id)])];
}

export async function listMembers(calendarId: string) {
  return db
    .select({
      id: schema.calendarMembers.id,
      userId: schema.calendarMembers.userId,
      role: schema.calendarMembers.role,
      addedAt: schema.calendarMembers.addedAt,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.calendarMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.calendarMembers.userId))
    .where(eq(schema.calendarMembers.calendarId, calendarId));
}

export async function listPendingInvitations(calendarId: string) {
  return db
    .select()
    .from(schema.calendarInvitations)
    .where(and(
      eq(schema.calendarInvitations.calendarId, calendarId),
      isNull(schema.calendarInvitations.acceptedAt),
    ));
}
