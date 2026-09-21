// 离线队列怎么推进 —— src/public/event-store.js 里那组纯函数。
//
// 为什么值得一个单独的文件：这里错一次的表现是「用户这几天的编辑全没了，而页面
// 一直显示已经改好了」。网页保存走的是乐观写 + 出队重放，本地那份带 _dirty 的副本
// 在合并时不会被服务端数据覆盖，所以只要一条改动卡在队头，用户在这台机器上
// 看到的永远是「存上了」，换台设备才发现白改。
//
// 被挡住的三条具体错法：
//   1. 把「服务端拒绝」和「网络断了」当成同一回事（4xx 也重试，重试到死也还是 4xx）
//   2. 拒绝的那条不出队，于是它永远是队头，后面排的全部发不出去
//   3. 已经放弃（giveUp）的条目留在队列里，照样挡住后面的
//
// 这里打的是纯逻辑：存储和网络都是假的，不需要 IndexedDB、不需要起服务。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// event-store.js 在 node 里只跑文件顶上那段纯逻辑（浏览器那一半自己判断没有 window
// 就直接 return），import 进来是为了拿 globalThis 上这份 API。
import "../src/public/event-store.js";

type Item = { id: number; op: string; eventId: string; giveUp?: boolean };
type Res = { ok: boolean; status: number; data?: unknown };

const core = (globalThis as unknown as {
  bwcOutboxCore: {
    isServerRejection(status: number): boolean;
    describeServerError(data: unknown, status: number): string;
    drainOutbox(
      items: Item[],
      ctx: Record<string, (...args: never[]) => unknown>,
    ): Promise<{ sent: number; rejected: number; skipped: number; blocked: boolean }>;
  };
}).bwcOutboxCore;

const item = (id: number, op = "update", extra: Partial<Item> = {}): Item =>
  ({ id, op, eventId: "ev-" + id, ...extra });

/** 假的副作用层：把 drainOutbox 做的每一件事按顺序记下来。 */
function harness(responder: (it: Item) => Res | Error) {
  const log: string[] = [];
  const rejected: Array<{ id: number; status: number; reason: string }> = [];
  const failed: Array<{ id: number; message: string }> = [];
  const ctx = {
    async send(it: Item) {
      log.push("send:" + it.id);
      const r = responder(it);
      if (r instanceof Error) throw r;
      return r;
    },
    async applied(it: Item) { log.push("applied:" + it.id); },
    async remove(it: Item) { log.push("remove:" + it.id); },
    async fail(it: Item, err: Error) {
      log.push("fail:" + it.id);
      failed.push({ id: it.id, message: err && err.message ? err.message : String(err) });
    },
    async reject(it: Item, info: { status: number; reason: string }) {
      log.push("reject:" + it.id);
      rejected.push({ id: it.id, status: info.status, reason: info.reason });
    },
  };
  return { ctx: ctx as unknown as Record<string, (...args: never[]) => unknown>, log, rejected, failed };
}

const reject400 = (message: string): Res =>
  ({ ok: false, status: 400, data: { error: "invalid_body", message } });
const ok = (data: unknown = { id: "server-id" }): Res => ({ ok: true, status: 200, data });

describe("isServerRejection — 哪些状态码是「再发一百次也是这个结果」", () => {
  it("4xx 一律不重试", () => {
    for (const s of [400, 401, 403, 404, 409, 413, 422]) {
      expect(core.isServerRejection(s), String(s)).toBe(true);
    }
  });

  it("408 / 429 例外：它们的意思是「现在不行」，不是「这条不行」", () => {
    expect(core.isServerRejection(408)).toBe(false);
    expect(core.isServerRejection(429)).toBe(false);
  });

  it("5xx 和「根本没发出去」都要重试", () => {
    for (const s of [0, 500, 502, 503, 504]) {
      expect(core.isServerRejection(s), String(s)).toBe(false);
    }
  });
});

describe("drainOutbox — 服务端拒绝的那一条", () => {
  it("被拒的条目出队，并且不挡住后面排队的编辑（一个 400 曾经让之后所有保存静默丢失）", async () => {
    const h = harness((it) => (it.id === 1 ? reject400("endsAt 早于 startsAt") : ok()));
    const stats = await core.drainOutbox([item(1), item(2), item(3)], h.ctx);

    expect(h.log).toEqual([
      "send:1", "reject:1", "remove:1",
      "send:2", "applied:2", "remove:2",
      "send:3", "applied:3", "remove:3",
    ]);
    expect(stats).toEqual({ sent: 2, rejected: 1, skipped: 0, blocked: false });
  });

  it("服务端那句带字段的说明原样交给界面，不是干巴巴一句「保存失败」", async () => {
    const h = harness(() => reject400("summary 不能为空"));
    await core.drainOutbox([item(1)], h.ctx);
    expect(h.rejected).toEqual([{ id: 1, status: 400, reason: "summary 不能为空" }]);
  });

  it("被拒的条目不会再走 applied —— 服务端没收下，本地镜像不能按「成功」对齐", async () => {
    const h = harness(() => ({ ok: false, status: 403, data: { error: "forbidden" } }));
    await core.drainOutbox([item(1)], h.ctx);
    expect(h.log).not.toContain("applied:1");
  });
});

describe("drainOutbox — 还有救的失败", () => {
  it("网络异常：记一次失败、留在队列里、停在这儿保序", async () => {
    const h = harness((it) => (it.id === 1 ? new Error("Failed to fetch") : ok()));
    const stats = await core.drainOutbox([item(1), item(2)], h.ctx);

    expect(h.log).toEqual(["send:1", "fail:1"]);
    expect(h.log).not.toContain("remove:1");
    expect(h.failed).toEqual([{ id: 1, message: "Failed to fetch" }]);
    expect(stats.blocked).toBe(true);
    expect(stats.sent).toBe(0);
  });

  it("429 限流不算拒绝：留着下一轮再发", async () => {
    const h = harness(() => ({ ok: false, status: 429, data: { message: "too many requests" } }));
    const stats = await core.drainOutbox([item(1)], h.ctx);
    expect(h.log).toEqual(["send:1", "fail:1"]);
    expect(stats.rejected).toBe(0);
    expect(h.failed[0]!.message).toBe("update_failed 429");
  });

  it("5xx 同理，留着重试", async () => {
    const h = harness(() => ({ ok: false, status: 503, data: null }));
    const stats = await core.drainOutbox([item(1)], h.ctx);
    expect(h.log).toEqual(["send:1", "fail:1"]);
    expect(stats.rejected).toBe(0);
  });
});

describe("drainOutbox — 已经放弃的条目", () => {
  it("跳过它继续发后面的：一条坏数据不许把整条队列锁死", async () => {
    const h = harness(() => ok());
    const stats = await core.drainOutbox([item(1, "update", { giveUp: true }), item(2)], h.ctx);

    expect(h.log).toEqual(["send:2", "applied:2", "remove:2"]);
    expect(stats).toEqual({ sent: 1, rejected: 0, skipped: 1, blocked: false });
  });

  it("跳过不等于丢掉：既不出队也不当成失败，用户还能在冲突面板里重试或丢弃", async () => {
    const h = harness(() => ok());
    await core.drainOutbox([item(1, "create", { giveUp: true })], h.ctx);
    expect(h.log).toEqual([]);
  });
});

describe("drainOutbox — 删除那条的 404", () => {
  it("服务端那边本来就没了，和删成功是一个意思", async () => {
    const h = harness(() => ({ ok: false, status: 404, data: { error: "not_found" } }));
    const stats = await core.drainOutbox([item(1, "delete")], h.ctx);
    expect(h.log).toEqual(["send:1", "applied:1", "remove:1"]);
    expect(stats).toEqual({ sent: 1, rejected: 0, skipped: 0, blocked: false });
  });

  it("但 create / update 的 404 是拒绝（事件已经被别处删了，重放没有意义）", async () => {
    const h = harness(() => ({ ok: false, status: 404, data: { error: "not_found" } }));
    const stats = await core.drainOutbox([item(1, "update")], h.ctx);
    expect(h.log).toEqual(["send:1", "reject:1", "remove:1"]);
    expect(stats.rejected).toBe(1);
  });
});

describe("describeServerError — 弹给用户的那句话", () => {
  it("优先取 message：/api/events 的 400 里只有它带着是哪个字段不对", () => {
    expect(core.describeServerError({ error: "invalid_body", message: "startsAt 不是合法时间" }, 400))
      .toBe("startsAt 不是合法时间");
  });

  it("没有 message 就退到 error", () => {
    expect(core.describeServerError({ error: "calendar_not_found" }, 404)).toBe("calendar_not_found");
  });

  it("纯文本响应原样用", () => {
    expect(core.describeServerError("payload too large", 413)).toBe("payload too large");
  });

  it("空响应退成状态码 —— 宁可给个号码，也不给一句空话", () => {
    expect(core.describeServerError(null, 401)).toBe("HTTP 401");
    expect(core.describeServerError({}, 400)).toBe("HTTP 400");
    expect(core.describeServerError("   ", 400)).toBe("HTTP 400");
  });

  it("网关塞回来的一整页 HTML 不往用户脸上贴", () => {
    expect(core.describeServerError("<!DOCTYPE html><html>502 Bad Gateway</html>", 502)).toBe("HTTP 502");
  });

  it("长文截断，别把一屏堆栈塞进 toast", () => {
    const out = core.describeServerError({ message: "x".repeat(500) }, 400);
    expect(out.length).toBe(201);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ---- 接线检查 ----
// 上面打的是纯逻辑，但纯逻辑再对，没接到真正的出队循环上也是白的。
const STORE_SRC = readFileSync(path.resolve("src/public/event-store.js"), "utf8");

describe("event-store.js 的出队循环确实走这套规则", () => {
  it("syncOutbox 把队列交给 drainOutbox，而不是自己再写一遍重试判断", () => {
    const fn = /async function syncOutbox\(\)[\s\S]*?\n  \}/.exec(STORE_SRC);
    expect(fn, "找不到 syncOutbox").toBeTruthy();
    expect(fn![0]).toMatch(/core\.drainOutbox\(/);
    // 循环里自己 break 就是老毛病：一条坏数据堵住全部。
    expect(fn![0]).not.toMatch(/\bbreak\b/);
  });

  it("被拒绝的那条会回滚本地副本 —— 不回滚的话页面会一直显示这条没存上的改动", () => {
    const fn = /async function rejectOne\([\s\S]*?\n  \}/.exec(STORE_SRC);
    expect(fn, "找不到 rejectOne").toBeTruthy();
    expect(fn![0]).toMatch(/rollbackLocal\(item\)/);
    expect(fn![0]).toMatch(/emit\("sync-rejected"/);
  });

  it("rollbackLocal 会清掉 _dirty —— mergeIntoLocal 见到 _dirty 是不覆盖的", () => {
    const fn = /async function rollbackLocal\([\s\S]*?\n  \}/.exec(STORE_SRC);
    expect(fn, "找不到 rollbackLocal").toBeTruthy();
    expect(fn![0]).toMatch(/delete .*\._dirty/);
  });
});
