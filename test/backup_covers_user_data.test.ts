import { describe, it, expect } from "vitest";
import * as schema from "../src/db/schema.js";
import { EXPORT_TABLES, BACKUP_EXCLUDED_TABLES } from "../src/lib/backup.js";

// 「以后再加一张用户数据表，会不会又被备份漏掉」。
//
// ── 为什么要有这条 ────────────────────────────────────────────────────
//
// 恢复备份是整库替换：先清空再插回去，而清空里包含 users。库里几乎每张
// 用户数据表都以 ON DELETE CASCADE 挂在 users 下面 —— **没写进备份清单的
// 表，会在清空那一步被连带删掉，插回去那一步根本不会碰它**。
//
// 已经这样丢过一次：预约链接和已收到的预约、三端 App 的登录凭据、
// SSO 绑定、网页推送订阅，四类数据在每一次「恢复备份」之后永久消失，
// 而页面只说了一句「恢复完成」。
//
// 靠人记得去改那张清单是靠不住的 —— 加表的时候没人会想到备份。
// 所以这里把它变成一条硬约束：**凡是带 user_id 的表，要么在备份清单里，
// 要么在「明确不备份」的名单里，二选一，不能两边都不在。**

/** 库里所有的表。
 *
 *  **判据是「所有表」而不是「带 user_id 的表」。** 一开始写的是后者，当场
 *  漏掉了 oauth_clients 和 webhooks —— 它们是站点级配置、身上没有 user_id，
 *  但丢了同样要命：所有第三方接入当场失效，而且密钥已经发给对方了，配不回原样。 */
function allTables(): string[] {
  const out: string[] = [];
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    // drizzle 的表对象上挂着真实表名
    const name = Object.getOwnPropertySymbols(value)
      .map((sy) => (value as unknown as Record<symbol, unknown>)[sy])
      .find((v): v is string => typeof v === "string" && /^[a-z_]+$/.test(v));
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

describe("备份清单必须盖住库里每一张表", () => {
  const included = new Set(EXPORT_TABLES.map((t) => t.name));

  it("确实枚举到了表（presence）", () => {
    // 少了这条，反射一旦失灵就变成「零张表全部合规」，恒绿。
    const found = allTables();
    expect(found.length, "一张表都没枚举到 —— 这条用例什么也没验到").toBeGreaterThan(20);
    expect(found, "连 devices 都没枚举到，说明表名取错了").toContain("devices");
    expect(found, "连 oauth_clients 都没枚举到").toContain("oauth_clients");
  });

  it.each(allTables())("%s 要么进备份，要么明确排除", (name) => {
    expect(
      included.has(name) || BACKUP_EXCLUDED_TABLES.has(name),
      `${name} 既不在备份清单里，也不在「明确不备份」名单里。\n` +
        "恢复备份时它会被 users 的级联删除带走，而且永远插不回来 —— " +
        "站长看到的只有一句「恢复完成」。\n" +
        "要么加进 EXPORT_TABLES（注意依赖顺序：父表在前），" +
        "要么加进 BACKUP_EXCLUDED_TABLES 并想清楚「这张表丢了用户不会发现」。",
    ).toBe(true);
  });

  it("两个名单不许重叠", () => {
    for (const n of included) {
      expect(BACKUP_EXCLUDED_TABLES.has(n), `${n} 同时出现在两个名单里`).toBe(false);
    }
  });
});
