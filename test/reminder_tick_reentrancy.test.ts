import { describe, it, expect, beforeEach } from "vitest";
import { makeReminderTick, __resetReminderTickStateForTest } from "../src/lib/reminders.js";

// 守「上一轮还没跑完，就别开下一轮」。
//
// 为什么这条必须有：提醒的发送顺序是**先发信、后落幂等行**。两轮重叠时，
// 第二轮读到的是第一轮还没提交的那批，于是照发一遍；而 markSent 撞唯一索引
// 回 false、sent 不计数 —— 于是**一批人各收到两封一模一样的提醒邮件，
// 而日志上一片安静**。
//
// 以前一条提醒 = 1 封信，一轮跑不满 60 秒，这个洞是理论上的。加上共享日历成员
// 之后变成「1 + 成员数 封」且串行发送，一个 50 人的日历同一分钟几条提醒就超过
// 60 秒，它就变成日常了。到点窗口是 ±60 秒，下一轮**必然**仍认为这批是到点的，
// 不存在「错开了就没事」。
// 实测（20 个成员，第二跳在第一跳 200ms 时进来）：21 人里 16 人各收两封。

const noopLog = { info: () => {}, warn: () => {} };
const emptyResult = { scanned: 0, sent: 0, failed: 0, skipped: 0 };

function capturingLog() {
  const warns: unknown[] = [];
  return { log: { info: () => {}, warn: (m: unknown) => { warns.push(m); } }, warns };
}

/** 手动控制何时完成的一次 dispatch。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { __resetReminderTickStateForTest(); });

describe("提醒调度：一轮没跑完不许开下一轮", () => {
  it("第二跳在第一跳还没跑完时进来 —— 不许再跑一次 dispatch", async () => {
    let dispatchCount = 0;
    const gate = deferred();
    const tick = makeReminderTick(noopLog, async () => {
      dispatchCount += 1;
      await gate.promise;
      return emptyResult;
    });

    const first = tick();          // 开始跑，卡在 gate 上
    await Promise.resolve();       // 让它真的进到 dispatch 里
    await tick();                  // 第二跳：应该当场返回

    expect(
      dispatchCount,
      "第二跳也跑了一遍 dispatch —— 它会读到第一轮还没提交的状态，把同一批提醒再发一次，" +
        "而 sent 计数回 0，日志上看不出来",
    ).toBe(1);

    gate.resolve();
    await first;
  });

  it("被跳过时要留一行 warn（悄悄跳过等于查不出为什么提醒迟了）", async () => {
    const { log, warns } = capturingLog();
    const gate = deferred();
    const tick = makeReminderTick(log, async () => { await gate.promise; return emptyResult; });

    const first = tick();
    await Promise.resolve();
    await tick();

    expect(warns.length, "跳过了却一行日志都没有").toBeGreaterThan(0);
    gate.resolve();
    await first;
  });

  it("上一轮跑完之后，下一跳必须能正常跑（守卫不许把自己永久锁死）", async () => {
    // presence 侧：只测「第二次被挡住」的话，把 tick 写成「永远直接 return」
    // 也能让上面两条全绿，而那样提醒一条都不会发。
    let dispatchCount = 0;
    const tick = makeReminderTick(noopLog, async () => { dispatchCount += 1; return emptyResult; });

    await tick();
    await tick();
    await tick();

    expect(dispatchCount, "串行的三跳应该各跑一次；守卫把自己锁死了").toBe(3);
  });

  it("dispatch 抛异常也要把在飞标志放开", async () => {
    let dispatchCount = 0;
    const tick = makeReminderTick(noopLog, async () => {
      dispatchCount += 1;
      throw new Error("boom");
    });

    await tick();
    await tick();

    expect(
      dispatchCount,
      "上一轮抛了异常，标志没放开 —— 提醒从此永久停摆，而且不报错",
    ).toBe(2);
  });
});
