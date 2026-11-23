// 同步推送（增量同步第三批）：事件一变，服务端主动 nudges 一下订阅了
// Web Push 的用户，打开着的页面被唤醒后自己走既有的 /events/sync 增量
// 拉取。轮询从此只是兜底（页面侧：有活跃订阅时 30 秒放宽到 5 分钟）。
//
// 为什么是「清扫器」而不是在写路径里挂钩：会写 events 的路径有三十来
// 处（这正是变更日志用触发器的原因，见 event_sync.ts）。清扫器只读
// event_changes 这一条现成的事实流：每 20 秒一跳，按每用户水位
// （sync_push_state，迁移 0073）找出「能看见的变化已经超过上次推送到
// 的位置」的人，每人聚合发一条。水位是持久化的：重启不重推历史、
// 不漏停机期间的变化（漏了也只是退化成轮询兜底，不会丢数据）。
//
// 载荷纪律：推送里**只有信号，没有数据** —— type 标记 + 一句本地化的
// 通用标题（SW 在平台强制展示时用，展示后立即关闭），绝不带事件标题、
// 时间、地点。事件内容永远只走带鉴权的同步接口，不经第三方推送通道。
//
// 门控口径：订阅本身就是用户在设置页的显式开启（关掉订阅 = 行删掉，
// 清扫器连候选都不会选他）。提醒/收件箱那两个分类开关管的是「看得见
// 的通知」，同步信号从不以可见通知的形式出现，所以不归它们管。

import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { syncWatermark } from "./event_sync.js";
import { pushToUser, type PushPayload } from "./push.js";
import { translate, type LocaleCode } from "./i18n.js";
import { recipientLocale, siteDefaultLocale } from "./event_change_notify.js";

/** 清扫节拍。变化到推送的典型延迟 ≤ 这个数；和下面的最小间隔共同
 *  决定最坏延迟（刚推过又来变化时 ≈ 节拍 + 间隔 ≈ 50 秒）。 */
export const SYNC_PUSH_TICK_MS = 20_000;

/** 同一用户两次同步推送的最小间隔。防滥发的主闸：连续编辑、导入、
 *  CalDAV 批量写入都会在一跳里被聚合掉，推完之后 30 秒内的新变化
 *  等下一跳合并再推 —— 反正页面拉一次增量就是全量变化，不丢。 */
export const SYNC_PUSH_MIN_INTERVAL_MS = 30_000;

/** 同步信号的投递 TTL。迟到几小时的「有变化」没有意义：浏览器回来
 *  打开页面自会拉齐。短 TTL 让推送服务直接丢弃过期信号。 */
export const SYNC_PUSH_TTL_SECONDS = 120;

/** 推送整体失败（sent = 0）后的退避。进程内即可：推送服务挂掉时别每
 *  20 秒对同一个人重试；重启后退避清零，最坏多试一轮。 */
const FAILURE_BACKOFF_MS = 5 * 60_000;

export type SyncPushStateLike = { pushedSeq: number; lastPushedAt: Date | null };

/** 节流判定（纯函数）：距上次成功推送不足最小间隔就是被节流。 */
export function syncPushThrottled(
  state: SyncPushStateLike,
  now: Date,
  minIntervalMs: number = SYNC_PUSH_MIN_INTERVAL_MS,
): boolean {
  return state.lastPushedAt != null && now.getTime() - state.lastPushedAt.getTime() < minIntervalMs;
}

/**
 * 同步推送的载荷（纯函数）。入参只有 locale —— 结构上就不可能带事件
 * 数据，测试可以直接断言这一点。title 是 SW 被平台强制展示通知时的
 * 兜底文案（订阅是 userVisibleOnly，见 sw.js 的说明），body 故意留空。
 */
export function buildSyncPushPayload(locale: LocaleCode): PushPayload {
  return {
    type: "events_sync",
    title: translate(locale, "notif.eventsSync.title"),
    body: "",
    url: "/app",
    tag: "bwc-events-sync",
  };
}

export type SyncPushSend = (
  userId: string,
  payload: PushPayload,
) => Promise<{ sent: number; failed: number }>;

const defaultSend: SyncPushSend = (userId, payload) =>
  pushToUser(userId, payload, { ttlSeconds: SYNC_PUSH_TTL_SECONDS });

const lastFailureAt = new Map<string, number>();

/**
 * (afterSeq, upToSeq] 区间内，这个人能看见的变化是否存在。可见性与
 * 同步端点同一口径（见 event_sync.changedEventIdsSince）：自己日历的
 * 变化靠 user_id（日历删了成员关系就没了，这一路不能丢），共享给自己
 * 的日历靠 calendar_id ∈ 当前成员关系。
 */
async function userHasVisibleChanges(userId: string, afterSeq: number, upToSeq: number): Promise<boolean> {
  const t = schema.eventChanges;
  const memberRows = await db
    .select({ calendarId: schema.calendarMembers.calendarId })
    .from(schema.calendarMembers)
    .where(eq(schema.calendarMembers.userId, userId));
  const memberIds = memberRows.map((r) => r.calendarId);
  const visibility = memberIds.length > 0
    ? or(eq(t.userId, userId), inArray(t.calendarId, memberIds))
    : eq(t.userId, userId);
  const [row] = await db
    .select({ changeSeq: t.changeSeq })
    .from(t)
    .where(and(gt(t.changeSeq, afterSeq), lte(t.changeSeq, upToSeq), visibility))
    .limit(1);
  return !!row;
}

export type SyncPushSweepResult = {
  /** 有订阅的候选用户数。 */
  users: number;
  /** 首次见到、本轮只立基线没推送的人数。 */
  baselined: number;
  /** 本轮真正发出推送的人数。 */
  pushed: number;
  /** 没有可见变化、水位静默推进的人数。 */
  advanced: number;
  /** 有变化但被最小间隔节流的人数（下一跳再推）。 */
  throttled: number;
  /** 发送失败（或退避中）的人数，水位不动。 */
  failed: number;
};

/**
 * 清扫一轮。opts.send / opts.now 只给测试用（注入发送端与时钟），生产
 * 路径走默认的 pushToUser 与真实时间。
 *
 * 水位推进策略（保守优先）：
 *   · 没水位行 → 以当前高度立基线，不补推历史；
 *   · 没有他能看见的变化 → 水位推进到当前高度（语义是「已考虑到此
 *     序号」，不然每跳都要重扫同一批不可见变化）；
 *   · 有变化但被节流/退避 → 水位不动，变化攒着，下一跳合并推；
 *   · 推送 sent ≥ 1（至少一个端点被推送服务收下）→ 水位推进 + 记
 *     last_pushed_at；sent = 0 → 水位不动 + 进程内退避。
 */
export async function runSyncPushSweep(
  opts?: { now?: Date; send?: SyncPushSend },
): Promise<SyncPushSweepResult> {
  const now = opts?.now ?? new Date();
  const send = opts?.send ?? defaultSend;
  const stats: SyncPushSweepResult = { users: 0, baselined: 0, pushed: 0, advanced: 0, throttled: 0, failed: 0 };

  const { high } = await syncWatermark();
  if (high <= 0) return stats;

  const subRows = await db
    .selectDistinct({ userId: schema.pushSubscriptions.userId })
    .from(schema.pushSubscriptions);
  stats.users = subRows.length;
  if (subRows.length === 0) return stats;

  const siteDefault = await siteDefaultLocale().catch(() => null);

  for (const { userId } of subRows) {
    try {
      const [state] = await db
        .select()
        .from(schema.syncPushState)
        .where(eq(schema.syncPushState.userId, userId))
        .limit(1);
      if (!state) {
        await db
          .insert(schema.syncPushState)
          .values({ userId, pushedSeq: high, lastPushedAt: null })
          .onConflictDoNothing();
        stats.baselined += 1;
        continue;
      }
      if (state.pushedSeq >= high) continue;

      const visible = await userHasVisibleChanges(userId, state.pushedSeq, high);
      if (!visible) {
        await db
          .update(schema.syncPushState)
          .set({ pushedSeq: high })
          .where(eq(schema.syncPushState.userId, userId));
        stats.advanced += 1;
        continue;
      }

      if (syncPushThrottled(state, now)) { stats.throttled += 1; continue; }
      const failedAt = lastFailureAt.get(userId);
      if (failedAt !== undefined && now.getTime() - failedAt < FAILURE_BACKOFF_MS) {
        stats.failed += 1;
        continue;
      }

      const [u] = await db
        .select({ locale: schema.users.locale })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const payload = buildSyncPushPayload(recipientLocale(u?.locale ?? null, siteDefault));
      const res = await send(userId, payload);
      if (res.sent > 0) {
        lastFailureAt.delete(userId);
        await db
          .update(schema.syncPushState)
          .set({ pushedSeq: high, lastPushedAt: now })
          .where(eq(schema.syncPushState.userId, userId));
        stats.pushed += 1;
      } else {
        lastFailureAt.set(userId, now.getTime());
        stats.failed += 1;
      }
    } catch (err) {
      // 单个用户出问题（DB 抖动、订阅行损坏）不能拖垮整轮清扫。
      stats.failed += 1;
      console.warn("[sync-push] sweep failed for one user:", (err as Error).message);
    }
  }
  return stats;
}

let started = false;
/** 上一轮还在飞（不是防重复启动，那是 started 干的）。推送是网络活，
 *  一轮慢过节拍时重入只会把同一批人推两遍 —— 水位在发送后才推进，
 *  两轮并发读到的都是旧水位。 */
let tickInFlight = false;

export function makeSyncPushTick(
  log: { info: (m: string) => void; warn: (m: unknown) => void },
  sweep: () => Promise<SyncPushSweepResult> = () => runSyncPushSweep(),
): () => Promise<void> {
  return async () => {
    if (tickInFlight) {
      log.warn({ msg: "[sync-push] 上一轮还没跑完，跳过这一跳" });
      return;
    }
    tickInFlight = true;
    try {
      const r = await sweep();
      if (r.pushed > 0) {
        log.info(`[sync-push] nudged ${r.pushed} user(s) about event changes`);
      }
      if (r.failed > 0) {
        log.warn({ msg: "[sync-push] tick had failed user(s)", failed: r.failed });
      }
    } catch (err) {
      log.warn({ err });
    } finally {
      tickInFlight = false;
    }
  };
}

export function startSyncPushScheduler(log: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (started) return;
  started = true;
  const tick = makeSyncPushTick(log);
  // 首跳延迟 30 秒：开机先让迁移和正常流量跑起来，清扫不急这一跳。
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, SYNC_PUSH_TICK_MS);
  log.info(`sync push scheduler started (${SYNC_PUSH_TICK_MS / 1000}s tick)`);
}

/** 只给测试用：把在飞标志和失败退避归位，免得用例之间互相串。 */
export function __resetSyncPushStateForTest(): void {
  tickInFlight = false;
  lastFailureAt.clear();
}
