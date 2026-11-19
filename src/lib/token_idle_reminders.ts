// 90 天未使用 API Token 的邮件提醒，由 housekeeping 的每日 tick 调用。
//
// 为什么要这层：长期凭据最大的风险不是被爆破，是被遗忘 —— 集成停用了、
// 人离职了，Token 还一直有效。提醒把「闲置凭据」重新送回主人眼前。
//
// 防打扰与防洪泛：
//   - 去重台账就用 admin_audit_log（action = api_token.idle_reminder，
//     targetId = token id）：同一 Token 30 天内只提醒一次，不新建表；
//   - 每轮上限 200 封，防一次性爆量（比如刚上线时存量闲置很多）；
//   - 只统计未撤销、未过期、主人未被禁用的 Token；「闲置」按
//     coalesce(lastUsedAt, createdAt) 算 —— 从没用过的按创建日算。
// 邮件只带 prefix（见 email_templates.tokenIdleReminderMail），无明文。

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { tokenIdleReminderMail } from "./email_templates.js";

export const IDLE_DAYS = 90;
export const REMIND_AGAIN_DAYS = 30;
const MAX_PER_TICK = 200;

export async function remindIdleApiTokens(now = new Date()): Promise<{ sent: number }> {
  const idleCutoff = new Date(now.getTime() - IDLE_DAYS * 24 * 60 * 60 * 1000);
  const dedupeCutoff = new Date(now.getTime() - REMIND_AGAIN_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select({
      id: schema.apiTokens.id,
      label: schema.apiTokens.label,
      prefix: schema.apiTokens.prefix,
      scope: schema.apiTokens.scope,
      idleSince: sql<Date>`coalesce(${schema.apiTokens.lastUsedAt}, ${schema.apiTokens.createdAt})`,
      ownerEmail: schema.users.email,
    })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(and(
      isNull(schema.apiTokens.revokedAt),
      or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now)),
      isNull(schema.users.disabledAt),
      sql`coalesce(${schema.apiTokens.lastUsedAt}, ${schema.apiTokens.createdAt}) < ${idleCutoff}`,
    ))
    .limit(MAX_PER_TICK);

  let sent = 0;
  for (const token of candidates) {
    const [recent] = await db
      .select({ id: schema.adminAuditLog.id })
      .from(schema.adminAuditLog)
      .where(and(
        eq(schema.adminAuditLog.action, "api_token.idle_reminder"),
        eq(schema.adminAuditLog.targetId, token.id),
        gt(schema.adminAuditLog.createdAt, dedupeCutoff),
      ))
      .limit(1);
    if (recent) continue;

    const res = await sendMail(tokenIdleReminderMail(token.ownerEmail, {
      label: token.label,
      prefix: token.prefix,
      scope: token.scope === "read" ? "read" : "write",
      idleSince: new Date(token.idleSince),
    }));
    // 邮件没发出去（邮局没配 / 发送失败）就不写台账，下一轮再试；
    // 写了台账却没发信，用户就白白少一次提醒。
    if (!res.ok) continue;

    await db.insert(schema.adminAuditLog).values({
      actorUserId: null,
      action: "api_token.idle_reminder",
      targetType: "api_token",
      targetId: token.id,
      details: { prefix: token.prefix },
      // ip 是 NOT NULL，系统动作没有请求 IP，沿用占位串的既有做法。
      ip: "-",
      userAgent: null,
    });
    sent += 1;
  }
  return { sent };
}
