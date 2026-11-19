import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { notifyEventUpdated } from "./event_change_notify.js";
import { notifyOrganizerProposal, notifyProposerResult } from "./invite_notify.js";

// 「提议新时间」的状态机收口：网页（公开回应页 + 组织者管理页）和 JSON
// API 都走这里，别在路由里各写一份 —— 尤其是「接受提议」这一步同时动
// 事件时间、提议状态和其他待处理提议，三处口径漂移就是数据事故。
//
// 规则：
//   · 提议凭 invite token 定位提议人（外部邮箱与站内账号同一条路）；
//     同一提议人对同一事件同时只能有一条 pending —— 再提一条，旧的
//     自动 superseded，不让组织者面对一堆过期提议。
//   · 接受 = 事件时间改成提议时间（一条事务里连同提议状态、其余
//     pending 提议的 superseded 一起落库），之后走既有 event_updated
//     口径通知全体相关人；提议人另收一条「已被接受」回执。
//   · 拒绝只动提议状态，事件不变，提议人收回执。
//   · 事件已取消 / token 已过期 / 事件不存在，一律拒绝提议。

type EventRow = typeof schema.events.$inferSelect;
type ProposalRow = typeof schema.eventTimeProposals.$inferSelect;

export type ProposalFailure =
  | "token_invalid" | "token_expired" | "event_missing" | "event_cancelled"
  | "bad_range" | "not_found" | "not_pending" | "not_owner";

export async function createTimeProposal(opts: {
  inviteToken: string;
  startsAt: Date;
  endsAt: Date;
  note?: string | null;
  proposerUserId?: string | null;
}): Promise<{ ok: true; proposal: ProposalRow } | { ok: false; error: ProposalFailure }> {
  if (!(opts.endsAt.getTime() > opts.startsAt.getTime())) return { ok: false, error: "bad_range" };
  const [tok] = await db
    .select()
    .from(schema.eventInviteTokens)
    .where(eq(schema.eventInviteTokens.token, opts.inviteToken))
    .limit(1);
  if (!tok) return { ok: false, error: "token_invalid" };
  if (tok.expiresAt < new Date()) return { ok: false, error: "token_expired" };
  const [event] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.id, tok.sourceEventId))
    .limit(1);
  if (!event) return { ok: false, error: "event_missing" };
  if (event.deletedAt) return { ok: false, error: "event_cancelled" };

  const proposal = await db.transaction(async (tx) => {
    await tx
      .update(schema.eventTimeProposals)
      .set({ status: "superseded", decidedAt: new Date() })
      .where(and(
        eq(schema.eventTimeProposals.sourceEventId, event.id),
        eq(schema.eventTimeProposals.inviteToken, tok.token),
        eq(schema.eventTimeProposals.status, "pending"),
      ));
    const [row] = await tx.insert(schema.eventTimeProposals).values({
      sourceEventId: event.id,
      inviteToken: tok.token,
      proposerEmail: tok.recipientEmail,
      proposerUserId: opts.proposerUserId ?? null,
      proposedStartsAt: opts.startsAt,
      proposedEndsAt: opts.endsAt,
      note: opts.note?.trim() ? opts.note.trim().slice(0, 500) : null,
      status: "pending",
    }).returning();
    return row;
  });
  if (!proposal) return { ok: false, error: "not_found" };
  await notifyOrganizerProposal({ event, proposal });
  return { ok: true, proposal };
}

export async function decideTimeProposal(opts: {
  proposalId: string;
  organizer: { id: string; email: string; displayName: string | null };
  accept: boolean;
}): Promise<{ ok: true; event: EventRow; proposal: ProposalRow } | { ok: false; error: ProposalFailure }> {
  const [proposal] = await db
    .select()
    .from(schema.eventTimeProposals)
    .where(eq(schema.eventTimeProposals.id, opts.proposalId))
    .limit(1);
  if (!proposal) return { ok: false, error: "not_found" };
  const [before] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.id, proposal.sourceEventId))
    .limit(1);
  if (!before) return { ok: false, error: "event_missing" };
  const [cal] = await db
    .select({ ownerId: schema.calendars.ownerId })
    .from(schema.calendars)
    .where(eq(schema.calendars.id, before.calendarId))
    .limit(1);
  if (!cal || cal.ownerId !== opts.organizer.id) return { ok: false, error: "not_owner" };
  if (proposal.status !== "pending") return { ok: false, error: "not_pending" };
  if (before.deletedAt) return { ok: false, error: "event_cancelled" };

  const now = new Date();
  const decided = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.eventTimeProposals)
      .set({ status: opts.accept ? "accepted" : "declined", decidedAt: now })
      .where(and(
        eq(schema.eventTimeProposals.id, proposal.id),
        eq(schema.eventTimeProposals.status, "pending"),
      ))
      .returning();
    if (!row) return null;
    if (opts.accept) {
      await tx
        .update(schema.events)
        .set({ startsAt: proposal.proposedStartsAt, endsAt: proposal.proposedEndsAt, updatedAt: now })
        .where(eq(schema.events.id, before.id));
      // 时间已经定了，其余 pending 提议讨论的是旧时间，全部顶掉。
      await tx
        .update(schema.eventTimeProposals)
        .set({ status: "superseded", decidedAt: now })
        .where(and(
          eq(schema.eventTimeProposals.sourceEventId, before.id),
          eq(schema.eventTimeProposals.status, "pending"),
          ne(schema.eventTimeProposals.id, proposal.id),
        ));
    }
    return row;
  });
  if (!decided) return { ok: false, error: "not_pending" };

  const [after] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.id, before.id))
    .limit(1);
  const finalEvent = after ?? before;
  if (opts.accept) {
    // 时间变更走既有口径：共享成员 + 已注册参与者收 event_updated。
    await notifyEventUpdated(before, finalEvent, opts.organizer);
  }
  await notifyProposerResult({ event: finalEvent, proposal: decided, accepted: opts.accept });
  return { ok: true, event: finalEvent, proposal: decided };
}

/** 组织者/提议人各自视角要读的提议列表（管理页与回应页共用）。 */
export async function listProposalsForEvent(eventId: string): Promise<ProposalRow[]> {
  return db
    .select()
    .from(schema.eventTimeProposals)
    .where(eq(schema.eventTimeProposals.sourceEventId, eventId))
    .orderBy(schema.eventTimeProposals.createdAt);
}
