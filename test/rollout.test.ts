// 灰度分桶 + 宽限天数归一化的判定表。
//
// 分桶算法是一份跨端协议：服务端分一次，Android / 桌面在本地对
// GitHub 清单再分一次（服务端够不着时）。三边必须逐位一致 —— 这里
// 钉死的向量，客户端那边的 Kotlin 测试（RolloutTest）用的是同一组
// 数字，改算法 = 三边一起改 + 这里改向量，别只改一处。
//
// 集成测试在 test/integration/update_policy.int.test.ts：那边验路由
// 真的在用这份判定（404 形状、召回豁免、参数解析），这边验判定本身。

import { describe, it, expect } from "vitest";
import {
  normalizeRolloutPercent,
  normalizeGraceDays,
  rolloutBucket,
  isInRollout,
} from "../src/lib/rollout.js";

describe("rolloutBucket 向量（三端一致的钉子）", () => {
  const vectors: Array<[string, "android" | "desktop", number, number]> = [
    ["device-alpha", "android", 26, 73],
    ["device-beta", "android", 26, 7],
    ["11111111-2222-3333-4444-555555555555", "desktop", 31, 64],
    ["device-alpha", "desktop", 26, 82],
    ["device-alpha", "android", 27, 89],
  ];
  for (const [deviceId, platform, versionCode, expected] of vectors) {
    it(`${platform}/${versionCode}/${deviceId} → ${expected}`, () => {
      expect(rolloutBucket(deviceId, platform, versionCode)).toBe(expected);
    });
  }

  it("同一输入重复算，结果不变（确定性）", () => {
    for (let i = 0; i < 5; i++) {
      expect(rolloutBucket("device-alpha", "android", 26)).toBe(73);
    }
  });

  it("桶值恒在 0–99", () => {
    for (const id of ["a", "b", "c", "x".repeat(64), "设备-甲"]) {
      const b = rolloutBucket(id, "android", 1);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });

  it("版本号进桶：同一设备对不同版本落点不同（不是永远第一批）", () => {
    expect(rolloutBucket("device-alpha", "android", 26)).not.toBe(
      rolloutBucket("device-alpha", "android", 27),
    );
  });
});

describe("normalizeRolloutPercent", () => {
  it("缺省 / 垃圾值一律回落 100（全量）—— 绝不能因为写错一个字把更新通道关小", () => {
    expect(normalizeRolloutPercent(undefined)).toBe(100);
    expect(normalizeRolloutPercent(null)).toBe(100);
    expect(normalizeRolloutPercent("abc")).toBe(100);
    expect(normalizeRolloutPercent(NaN)).toBe(100);
    expect(normalizeRolloutPercent(Infinity)).toBe(100);
    // 数字形态的字符串按数字读（手写清单写成 "10" 不该被当成非法）。
    expect(normalizeRolloutPercent("10")).toBe(10);
  });
  it("正常值取整并夹进 0–100", () => {
    expect(normalizeRolloutPercent(10)).toBe(10);
    expect(normalizeRolloutPercent(10.9)).toBe(10);
    expect(normalizeRolloutPercent(0)).toBe(0);
    expect(normalizeRolloutPercent(-5)).toBe(0);
    expect(normalizeRolloutPercent(250)).toBe(100);
  });
});

describe("normalizeGraceDays", () => {
  it("缺省 / 垃圾值回落 7 天", () => {
    expect(normalizeGraceDays(undefined)).toBe(7);
    expect(normalizeGraceDays(null)).toBe(7);
    expect(normalizeGraceDays("abc")).toBe(7);
    expect(normalizeGraceDays(NaN)).toBe(7);
    expect(normalizeGraceDays("14")).toBe(14);
  });
  it("0 是合法值（不给宽限，立即强升）；上限夹到 30", () => {
    expect(normalizeGraceDays(0)).toBe(0);
    expect(normalizeGraceDays(14)).toBe(14);
    expect(normalizeGraceDays(90)).toBe(30);
    expect(normalizeGraceDays(-1)).toBe(0);
  });
});

describe("isInRollout", () => {
  const base = {
    deviceId: "device-beta", // android/26 的桶 = 7
    platform: "android" as const,
    versionCode: 26,
    currentVersionCode: 25,
    minSupportedVersionCode: 1,
  };

  it("比例 100：所有人都可见（关灰度回全量）", () => {
    expect(isInRollout({ ...base, rolloutPercent: 100 })).toBe(true);
    expect(isInRollout({ ...base, deviceId: "device-alpha", rolloutPercent: 100 })).toBe(true);
  });

  it("比例 0：谁都看不到（暂停放量）", () => {
    expect(isInRollout({ ...base, rolloutPercent: 0 })).toBe(false);
  });

  it("边界：桶值恰好等于比例时不可见（bucket < percent）", () => {
    // device-beta 桶 = 7：比例 7 不可见、8 可见。
    expect(isInRollout({ ...base, rolloutPercent: 7 })).toBe(false);
    expect(isInRollout({ ...base, rolloutPercent: 8 })).toBe(true);
  });

  it("单调性：比例只扩不缩 —— 10% 可见的设备在 50% / 100% 仍可见", () => {
    // device-beta 桶 7，在 10% 时已可见。
    expect(isInRollout({ ...base, rolloutPercent: 10 })).toBe(true);
    expect(isInRollout({ ...base, rolloutPercent: 50 })).toBe(true);
    expect(isInRollout({ ...base, rolloutPercent: 100 })).toBe(true);
    // device-alpha 桶 73：10% 不可见、74% 起可见、之后一直可见。
    const alpha = { ...base, deviceId: "device-alpha" };
    expect(isInRollout({ ...alpha, rolloutPercent: 10 })).toBe(false);
    expect(isInRollout({ ...alpha, rolloutPercent: 74 })).toBe(true);
    expect(isInRollout({ ...alpha, rolloutPercent: 100 })).toBe(true);
  });

  it("没有设备标识：可见 —— 分不了桶就不能装作分了（接口兼作后台自检与下载页口径）", () => {
    expect(isInRollout({ ...base, deviceId: null, rolloutPercent: 50 })).toBe(true);
    expect(isInRollout({ ...base, deviceId: "", rolloutPercent: 50 })).toBe(true);
    expect(isInRollout({ ...base, deviceId: "  ", rolloutPercent: 50 })).toBe(true);
  });

  it("召回豁免：已装版本低于最低支持版本时无视灰度，全量下发", () => {
    // device-alpha 桶 73，灰度只开 10%，但它装的 20 低于最低 24 → 可见。
    expect(isInRollout({
      ...base, deviceId: "device-alpha", rolloutPercent: 10,
      currentVersionCode: 20, minSupportedVersionCode: 24,
    })).toBe(true);
    // 恰好等于最低版本不算「低于」→ 照常分桶。
    expect(isInRollout({
      ...base, deviceId: "device-alpha", rolloutPercent: 10,
      currentVersionCode: 24, minSupportedVersionCode: 24,
    })).toBe(false);
    // 没上报已装版本 → 没有豁免依据，照常分桶。
    expect(isInRollout({
      ...base, deviceId: "device-alpha", rolloutPercent: 10,
      currentVersionCode: null, minSupportedVersionCode: 24,
    })).toBe(false);
  });

  it("清单里的比例先过归一化：写成非数字符串回落全量，数字字符串按数字读", () => {
    expect(isInRollout({ ...base, rolloutPercent: "abc" as unknown as number })).toBe(true);
    // device-beta 桶 7：数字字符串 "8" 按 8 读 → 可见；"7" → 不可见。
    expect(isInRollout({ ...base, rolloutPercent: "8" as unknown as number })).toBe(true);
    expect(isInRollout({ ...base, rolloutPercent: "7" as unknown as number })).toBe(false);
  });
});
