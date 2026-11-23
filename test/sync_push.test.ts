import { describe, it, expect } from "vitest";
import {
  buildSyncPushPayload,
  syncPushThrottled,
  SYNC_PUSH_MIN_INTERVAL_MS,
} from "../src/lib/sync_push.js";

// 同步推送的纯逻辑：载荷构造与节流判定。带状态的部分（水位推进、
// 可见性、退避）在 test/integration/sync_push.int.test.ts 里打真库。
describe("sync push payload", () => {
  it("只有信号、没有数据：键固定，body 为空，标题按 locale 走", () => {
    const zh = buildSyncPushPayload("zh-CN");
    expect(zh.type).toBe("events_sync");
    expect(zh.tag).toBe("bwc-events-sync");
    expect(zh.url).toBe("/app");
    expect(zh.body).toBe("");
    expect(zh.title).toBe("日历有更新");
    expect(Object.keys(zh).sort()).toEqual(["body", "tag", "title", "type", "url"]);

    const en = buildSyncPushPayload("en");
    expect(en.title).toBe("Calendar updated");
  });
});

describe("sync push throttle", () => {
  const now = new Date("2026-11-24T00:01:00Z");

  it("从没推过 → 不节流", () => {
    expect(syncPushThrottled({ pushedSeq: 0, lastPushedAt: null }, now)).toBe(false);
  });

  it("刚推过（间隔内）→ 节流", () => {
    const last = new Date(now.getTime() - (SYNC_PUSH_MIN_INTERVAL_MS - 1));
    expect(syncPushThrottled({ pushedSeq: 5, lastPushedAt: last }, now)).toBe(true);
  });

  it("过了最小间隔 → 不节流", () => {
    const last = new Date(now.getTime() - SYNC_PUSH_MIN_INTERVAL_MS);
    expect(syncPushThrottled({ pushedSeq: 5, lastPushedAt: last }, now)).toBe(false);
  });

  it("自定义间隔生效", () => {
    const last = new Date(now.getTime() - 10_000);
    expect(syncPushThrottled({ pushedSeq: 5, lastPushedAt: last }, now, 5_000)).toBe(false);
    expect(syncPushThrottled({ pushedSeq: 5, lastPushedAt: last }, now, 60_000)).toBe(true);
  });
});
