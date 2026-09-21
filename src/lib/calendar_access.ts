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

/** 日历的一个「相关人」。isOwner 用来区分所有者和被邀请进来的成员。 */
export type CalendarAudienceEntry = { userId: string; isOwner: boolean };

/**
 * 一个日历的收件人集合 = 所有者 + calendar_members 里的全部成员，去重，所有者排第一。
 *
 * 为什么是纯函数、又为什么放在这个文件：
 * 「谁算这个日历的人」这件事上面 getUserRole/canView 已经有一份定义了（所有者，
 * 或者 calendar_members 里有一行，两者都不是就没权限）。提醒扫描器要按同一个集合
 * 发信，但它是每分钟批量跑的，不能一个日历一次 getUserRole 往返，只能自己拼。
 * 两处各拼各的，以后再多一种共享方式（比如公开订阅），改了可见性那边、漏了这边，
 * 表现是「他在日历上看得见这个事件，但永远收不到它的提醒」—— 不报错，没人会来报。
 * 所以把拼装规则抽成这一个纯函数，两边共用，改的时候只有一处。
 *
 * 所有者排第一不是为了好看：他同时也可能躺在 calendar_members 里（历史数据、
 * 或者管理员手工加过一行），先放他再按 userId 去重，才能保证他只收一份。
 */
export function composeCalendarAudience(
  ownerId: string,
  memberUserIds: readonly string[],
): CalendarAudienceEntry[] {
  const out: CalendarAudienceEntry[] = [];
  const seen = new Set<string>();
  if (ownerId) {
    out.push({ userId: ownerId, isOwner: true });
    seen.add(ownerId);
  }
  for (const userId of memberUserIds) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, isOwner: false });
  }
  return out;
}
