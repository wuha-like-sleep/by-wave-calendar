import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

// 站内通知的读写收口。生产者（日历邀请、新预约、预约取消）只管调
// createNotification，用户侧（铃铛未读数、通知页、标已读）只从这里读。
//
// 一条总原则：**通知永远是业务动作的旁路**。写通知失败（表还没迁移、
// DB 抖动）绝不能让邀请发不出去、预约下不了单 —— 所以 createNotification
// 不抛异常，失败只在返回值里体现，调用方该干嘛干嘛。反过来读不到通知
// 也只是铃铛不亮，不许拖垮页面渲染，所以读函数同样把异常收成空结果。

export type NotificationType = "calendar_invitation" | "booking_created" | "booking_cancelled";

export type NewNotificationInput = {
  userId: string;
  type: NotificationType;
  /** 写入时已按收件人 locale 定稿的标题（见 schema.ts notifications 的注释）。 */
  title: string;
  body?: string | null;
  /** 站内路径，必须以 / 开头且不是 //（防开放重定向）；不合规直接丢弃为 null。 */
  url?: string | null;
};

/** 只允许站内路径。//evil.com 这种协议相对地址一律不收。 */
export function safeNotificationUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  if (url.length > 500) return null;
  return url;
}

export async function createNotification(input: NewNotificationInput): Promise<boolean> {
  try {
    await db.insert(schema.notifications).values({
      userId: input.userId,
      type: input.type,
      title: input.title.slice(0, 300),
      body: input.body ? input.body.slice(0, 1000) : null,
      url: safeNotificationUrl(input.url),
    });
    return true;
  } catch (err) {
    console.warn("[notifications] create failed:", (err as Error).message);
    return false;
  }
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** 未读数接口的 ETag 原料：条数相同但新来了一条时也要变，所以带上最新一行的时间。 */
export async function unreadNotificationsEtag(userId: string): Promise<string> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int`, latest: sql<string | null>`max(${schema.notifications.createdAt})` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
    const latestMs = row?.latest ? new Date(row.latest).getTime() : 0;
    return `"unread-${row?.n ?? 0}-${latestMs}"`;
  } catch {
    return `"unread-0-0"`;
  }
}

export async function listNotifications(userId: string, limit = 50): Promise<schema.Notification[]> {
  try {
    return await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
      .limit(limit);
  } catch {
    return [];
  }
}

export async function getNotification(userId: string, id: string): Promise<schema.Notification | null> {
  try {
    const [row] = await db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/** 标单条已读。返回这条通知（标读前的快照即可，调用方只需要它的 url）。 */
export async function markNotificationRead(userId: string, id: string): Promise<schema.Notification | null> {
  const row = await getNotification(userId, id);
  if (!row) return null;
  if (!row.readAt) {
    try {
      await db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
    } catch {
      // 标不上也不拦用户跳转 —— 跳过去看了就是看了，下次再标。
    }
  }
  return row;
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  try {
    await db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  } catch {
    // 同上：旁路失败不外抛。
  }
}

/** 已读通知的保留期。和软删事件同口径 90 天；未读的不删（那是用户的待办）。 */
const READ_NOTIFICATION_RETENTION_DAYS = 90;

export async function purgeOldReadNotifications(): Promise<{ purged: number }> {
  const cutoff = new Date(Date.now() - READ_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(schema.notifications)
    .where(and(isNotNull(schema.notifications.readAt), lt(schema.notifications.readAt, cutoff)))
    .returning({ id: schema.notifications.id });
  return { purged: result.length };
}
