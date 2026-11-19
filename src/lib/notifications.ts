import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { pushToUser } from "./push.js";

// 站内通知的读写收口。生产者（日历邀请、新预约、预约取消）只管调
// createNotification，用户侧（铃铛未读数、通知页、标已读）只从这里读。
//
// 一条总原则：**通知永远是业务动作的旁路**。写通知失败（表还没迁移、
// DB 抖动）绝不能让邀请发不出去、预约下不了单 —— 所以 createNotification
// 不抛异常，失败只在返回值里体现，调用方该干嘛干嘛。反过来读不到通知
// 也只是铃铛不亮，不许拖垮页面渲染，所以读函数同样把异常收成空结果。

export type NotificationType =
  | "calendar_invitation" | "booking_created" | "booking_cancelled"
  | "event_updated" | "event_cancelled" | "security_alert"
  | "event_invitation" | "rsvp_response" | "time_proposal" | "time_proposal_result";

export type NewNotificationInput = {
  userId: string;
  type: NotificationType;
  /** 写入时已按收件人 locale 定稿的标题（见 schema.ts notifications 的注释）。 */
  title: string;
  body?: string | null;
  /** 站内路径，必须以 / 开头且不是 //（防开放重定向）；不合规直接丢弃为 null。 */
  url?: string | null;
  /**
   * 给了就代表「这条站内通知值得再推一份 Web Push」——但只在收件人的
   * notify_inbox_push 没关时真推。哪些类型配给 push 由生产者按口径决定
   * （邀请/预约/安全/事件取消给，事件更新不给：高频低急迫，站内+角标足够，
   * 全推就是和邮件、提醒三重打扰）。actionLabel 是「查看」按钮的文案，
   * 由生产者按收件人 locale 定稿后传入（本库不感知 locale）。
   */
  push?: { actionLabel: string };
};

/** 只允许站内路径。//evil.com 这种协议相对地址一律不收。 */
export function safeNotificationUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  if (url.length > 500) return null;
  return url;
}

async function insertNotification(input: NewNotificationInput): Promise<schema.Notification | null> {
  try {
    const [row] = await db.insert(schema.notifications).values({
      userId: input.userId,
      type: input.type,
      title: input.title.slice(0, 300),
      body: input.body ? input.body.slice(0, 1000) : null,
      url: safeNotificationUrl(input.url),
    }).returning();
    return row ?? null;
  } catch (err) {
    console.warn("[notifications] create failed:", (err as Error).message);
    return null;
  }
}

/**
 * 站内通知的可选 Web Push 镜像。门控只有一道：收件人的 notify_inbox_push。
 * 它和提醒推送（notify_reminder_push）是两个开关 —— 关掉这个只停「收件箱
 * 重要事项」的推送，事件提醒照常推，反之亦然。推送失败/没订阅都是常态，
 * 全吞掉，绝不影响站内那条已经落库的通知。
 */
async function maybePushNotification(input: NewNotificationInput, row: schema.Notification): Promise<void> {
  if (!input.push) return;
  try {
    const [user] = await db
      .select({ notifyInboxPush: schema.users.notifyInboxPush })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);
    if (!user || user.notifyInboxPush === false) return;
    await pushToUser(input.userId, {
      title: row.title,
      body: row.body ?? "",
      url: row.url ?? "/app/notifications",
      // 同一条通知在系统通知中心里只占一格（重发同 tag 会替换而不是叠加）。
      tag: `inbox-${row.id}`,
      actions: [{ action: "view", title: input.push.actionLabel }],
    });
  } catch (err) {
    console.warn("[notifications] push mirror failed:", (err as Error).message);
  }
}

export async function createNotification(input: NewNotificationInput): Promise<boolean> {
  const row = await insertNotification(input);
  if (!row) return false;
  await maybePushNotification(input, row);
  return true;
}

/**
 * 合并版写入：给「同一件事短时间内反复发生」用（典型是事件被连续修改）。
 * 窗口内已有同 (userId, type, url) 的**未读**通知时，不新增一行，而是把
 * 那行的标题/正文刷新成最新状态、createdAt 推到现在 —— 收件箱里永远只有
 * 一条「这条日程又变了」，角标也不会被连环编辑顶爆。已读的不合并（那是
 * 上一段历史，新变化值得一条新的）。url 里嵌着事件深链接，天然就是
 * 「同一件事」的判据。
 */
export async function createNotificationCoalesced(
  input: NewNotificationInput,
  windowMs = 30 * 60 * 1000,
): Promise<boolean> {
  const url = safeNotificationUrl(input.url);
  if (url) {
    try {
      const since = new Date(Date.now() - windowMs);
      const [existing] = await db
        .select()
        .from(schema.notifications)
        .where(and(
          eq(schema.notifications.userId, input.userId),
          eq(schema.notifications.type, input.type),
          eq(schema.notifications.url, url),
          isNull(schema.notifications.readAt),
          gte(schema.notifications.createdAt, since),
        ))
        .orderBy(desc(schema.notifications.createdAt))
        .limit(1);
      if (existing) {
        await db
          .update(schema.notifications)
          .set({
            title: input.title.slice(0, 300),
            body: input.body ? input.body.slice(0, 1000) : null,
            createdAt: new Date(),
          })
          .where(eq(schema.notifications.id, existing.id));
        return true;
      }
    } catch (err) {
      console.warn("[notifications] coalesce lookup failed:", (err as Error).message);
      // 查不到就退回普通新增 —— 宁可多一条，不可丢一条。
    }
  }
  return createNotification({ ...input, url });
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
