import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { etagOf } from "./calendar_ctag.js";

// GET /invitations 的 ETag 原料。那个接口的正文由四摊东西拼成，令牌
// 必须把四摊都盖住，少一摊就是「数据变了、令牌没变、客户端拿 304
// 把新数据挡在门外」：
//
//   · 发给我的 token 本身：新建邀请（insert）、撤销邀请（delete，
//     只删未接受的）——靠「我名下事件集合上全部 token 的条数 +
//     max(createdAt)」盖住，集合里多一个人、少一个人都算。
//   · 任何一位受邀者的回应：RSVP 的三条写路（API / 网页 / CalDAV）
//     都同时写 responseStatus 和 respondedAt —— max(respondedAt)
//     盖住。token 表没有 updatedAt 列，respondedAt 就是它的变更戳。
//   · 事件正文（标题、时间、取消状态）：一切事件写路都 bump
//     events.updatedAt（审计核过，含参与者增删与回复时顺手的那次），
//     max(updatedAt) 盖住。
//   · 我的提议：新建靠条数 + max(createdAt)，被组织者裁决或被新提议
//     顶掉都写 decidedAt —— max(decidedAt) 盖住。
//
// 不在正文里的字段不进令牌：acceptedAt（「加进我的日历」）不出现在
// 这个接口的响应里，它变了正文没变，令牌也不该变。
// 组织者/受邀者的显示名也在正文里，但改名是低频旁路，与未读数 ETag
// 不覆盖通知标题改动同级，这里不为它多查一摊 users。

function ms(v: string | Date | null | undefined): number {
  if (v == null) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

export async function invitationsEtag(email: string): Promise<string> {
  const lower = email.toLowerCase();
  const mine = await db
    .select({ token: schema.eventInviteTokens.token, sourceEventId: schema.eventInviteTokens.sourceEventId })
    .from(schema.eventInviteTokens)
    .where(eq(sql<string>`lower(${schema.eventInviteTokens.recipientEmail})`, lower));
  if (mine.length === 0) return etagOf("invitations|empty");
  const eventIds = [...new Set(mine.map((t) => t.sourceEventId))];
  const myTokens = mine.map((t) => t.token);
  const [tokAgg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      maxCreated: sql<string | null>`max(${schema.eventInviteTokens.createdAt})`,
      maxResponded: sql<string | null>`max(${schema.eventInviteTokens.respondedAt})`,
    })
    .from(schema.eventInviteTokens)
    .where(inArray(schema.eventInviteTokens.sourceEventId, eventIds));
  const [evAgg] = await db
    .select({ maxUpdated: sql<string | null>`max(${schema.events.updatedAt})` })
    .from(schema.events)
    .where(inArray(schema.events.id, eventIds));
  const [propAgg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      maxCreated: sql<string | null>`max(${schema.eventTimeProposals.createdAt})`,
      maxDecided: sql<string | null>`max(${schema.eventTimeProposals.decidedAt})`,
    })
    .from(schema.eventTimeProposals)
    .where(inArray(schema.eventTimeProposals.inviteToken, myTokens));
  return etagOf(JSON.stringify([
    "invitations",
    tokAgg?.n ?? 0, ms(tokAgg?.maxCreated), ms(tokAgg?.maxResponded),
    ms(evAgg?.maxUpdated),
    propAgg?.n ?? 0, ms(propAgg?.maxCreated), ms(propAgg?.maxDecided),
  ]));
}
