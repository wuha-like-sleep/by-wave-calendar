// 事件增量同步（syncToken 模型）的服务端原语：令牌编解码、过期判定、
// 变更日志的水位查询与裁剪。端点本体在 routes/events.ts 的 GET /events/sync。
//
// 模型照 Google Calendar API 的 syncToken：
//   · 令牌是不透明字符串，只编码一个序号（event_changes.change_seq，全表统一水位）；
//   · 无令牌 = 初始全量；带令牌 = 只回序号之后的变化；
//   · 令牌指向的序号若已被日志裁剪掉（保留期 30 天），回 410 Gone，
//     客户端据此丢掉本地镜像、全量重建 —— 宁可重来，不可静默缺数据。
//
// 日志由迁移 0072 的触发器在每个写路径的同一事务里追加，应用代码不写它。
// 序号的水位口径：high 取日志里**已经落表**的最大序号。并发事务先拿号、
// 后提交时，它的序号会比 high 大、行却还没出现 —— 用「已落表的最大值」
// 当水位，那条变化会在下一次增量里被带出来，不会被令牌跳过。

import { and, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const t = schema.eventChanges;

/** 变更日志保留天数。超过这个岁数的令牌一律 410，与 Google 的口径一致。 */
export const EVENT_CHANGES_RETENTION_DAYS = 30;

/** 一次增量最多解析多少个变更主事件。再多就回 410 让客户端全量重同步：
 *  增量响应比全量还大时，增量本身就没有意义了（多见于导入了一大批事件
 *  又攒了很久没同步的客户端）。 */
export const MAX_DELTA_MASTERS = 5000;

const TOKEN_PREFIX = "bwcs1.";

/** 序号 → 不透明令牌。格式带版本前缀，将来换编码不用和老令牌猜来猜去。 */
export function encodeSyncToken(seq: number): string {
  return Buffer.from(`${TOKEN_PREFIX}${seq}`, "utf8").toString("base64url");
}

/** 令牌 → 序号。解不出来（坏的、别的系统发的、老格式）一律 null，端点按 410 处理：
 *  客户端拿到 410 就全量重建，是能自愈的那条路；回 400 只会让它带着坏令牌反复重试。 */
export function decodeSyncToken(raw: string): number | null {
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    if (!s.startsWith(TOKEN_PREFIX)) return null;
    const n = Number(s.slice(TOKEN_PREFIX.length));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 令牌过期判定（纯函数，测试直接打这里）：
 *   · seq 比水位还大 —— 令牌不是这条日志发的（恢复过的库、另一台机器），不可信；
 *   · seq 落在「已被裁掉的最大序号」之下 —— 它之后、日志现存最老一条之前的
 *     变化已经没了，增量拼不完整。
 * floor 是日志现存的最小序号（空表时为 null，此时水位只能是 0）。
 */
export function syncTokenExpired(seq: number, floor: number | null, high: number): boolean {
  if (seq > high) return true;
  const minRetained = floor ?? high + 1;
  return seq < minRetained - 1;
}

/** 当前水位：已落表的最大序号（high）与现存最小序号（floor，空表为 null）。 */
export async function syncWatermark(): Promise<{ high: number; floor: number | null }> {
  const [agg] = await db
    .select({
      high: sql<string>`coalesce(max(${t.changeSeq}), 0)::text`,
      floor: sql<string | null>`min(${t.changeSeq})::text`,
    })
    .from(t);
  return {
    high: Number(agg?.high ?? 0),
    floor: agg?.floor == null ? null : Number(agg.floor),
  };
}

/**
 * (seq, high] 区间内、这个人能看见的变化，按事件去重后返回事件 id 列表。
 * 可见性有两路，缺一不可：
 *   · user_id = 本人 —— 自己日历上的变化，包括日历已经删掉之后留下的删除行
 *     （那时按日历查可见性，日历行已经不在了）；
 *   · calendar_id ∈ 当前可见日历 —— 别人共享给自己的日历，日志里记的所有者
 *     是对方，只能靠日历这一路捞到。
 */
export async function changedEventIdsSince(
  userId: string,
  visibleCalendarIds: string[],
  seq: number,
  high: number,
): Promise<string[]> {
  if (high <= seq) return [];
  const visibility = visibleCalendarIds.length > 0
    ? or(eq(t.userId, userId), inArray(t.calendarId, visibleCalendarIds))
    : eq(t.userId, userId);
  const rows = await db
    .select({ eventId: t.eventId })
    .from(t)
    .where(and(gt(t.changeSeq, seq), lte(t.changeSeq, high), visibility))
    .groupBy(t.eventId);
  return rows.map((r) => r.eventId);
}

/** 裁掉保留期之外的日志行。挂在 housekeeping 的每日 tick 上（见 housekeeping.ts）。 */
export async function pruneEventChanges(): Promise<{ purged: number }> {
  const cutoff = new Date(Date.now() - EVENT_CHANGES_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(t)
    .where(lt(t.at, cutoff))
    .returning({ changeSeq: t.changeSeq });
  return { purged: rows.length };
}
