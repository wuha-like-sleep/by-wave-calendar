import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 纯逻辑档(`npm test`)里没有 Postgres:db/client 一 import 就建连接池,
// env 会校验 DATABASE_URL / SESSION_SECRET 之类的必填项。挡掉这两个,
// 剩下的 toView 就是一个纯函数。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({
  env: {
    SITE_NAME: "ByWave-Calendar",
    ICP_NUMBER: null,
    ICP_URL: "https://beian.miit.gov.cn/",
    SMTP_PORT: 465,
    MAIL_FROM_NAME: "ByWave-Calendar",
  },
}));

import { toView } from "../src/lib/site_settings.js";
import { siteSettings } from "../src/db/schema.js";

// 模拟一台还没跑到 0048 的老库读回来的那一行:
// **新列的属性根本不存在**(undefined),不是 null —— 这是这个测试的全部重点。
// 断言 undefined 而不是断言 null 的原因:自动迁移和真实 schema 对不上时
// (本仓库出过),select 返回的对象里就是没有这个 key。
//
// 这里要 cast:行类型有五十来个列,一个个填满只会让这个测试变得没人敢改,
// 而 toView 对其余列的回落不是这条测试要守的东西。
const OLD_ROW = {
  id: 1,
  siteName: "ByWave-Calendar",
  logoUrl: null,
  registrationMode: "public",
  // signupDomainAllowlist / signupDailyQuota 故意不写 —— 老库没有这两列。
} as unknown as Parameters<typeof toView>[0];

describe("建号闸门的新设置项:老库回落", () => {
  it("列缺失时域名白名单回落到「不限制」(空串),不是回落到某个域名", () => {
    expect(toView(OLD_ROW).signupDomainAllowlist).toBe("");
  });

  it("列缺失时每日配额回落到「不限」(0),不是回落到某个正数上限", () => {
    expect(toView(OLD_ROW).signupDailyQuota).toBe(0);
  });

  it("列有值时原样透传,不被回落覆盖", () => {
    const row = {
      ...OLD_ROW,
      signupDomainAllowlist: "example.com, corp.example.net",
      signupDailyQuota: 20,
    } as unknown as Parameters<typeof toView>[0];
    const v = toView(row);
    expect(v.signupDomainAllowlist).toBe("example.com, corp.example.net");
    expect(v.signupDailyQuota).toBe(20);
  });
});

// 上面守的是「读代码的回落」。下面两条守的是另外两处也能独立把升级搞挂的
// 默认值:drizzle 的列定义(新装机器建表用它)和迁移 SQL(存量库加列用它)。
// 三处里任何一处写成限制性的,客户升级当天注册就停,所以三处都得有断言。
describe("新设置项的默认值必须保持现状(空 / 0)", () => {
  it("drizzle 列定义的默认值是不限制的", () => {
    expect(siteSettings.signupDomainAllowlist.default).toBe("");
    expect(siteSettings.signupDailyQuota.default).toBe(0);
  });

  it("0048 迁移给存量库加列时也用不限制的默认值,且可重入", () => {
    const sqlText = readFileSync(
      path.join(process.cwd(), "drizzle/migrations/0048_signup_gates.sql"),
      "utf8",
    );
    // 去掉注释行,免得注释里提到这些字样就把断言喂饱了。
    const stmts = sqlText
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");

    expect(stmts).toContain("signup_domain_allowlist text NOT NULL DEFAULT ''");
    expect(stmts).toContain("signup_daily_quota integer NOT NULL DEFAULT 0");
    // 自动迁移每次开机都跑,迁移器记账错乱时会重放 —— SQL 自己必须是 no-op。
    expect(stmts).not.toMatch(/ALTER TABLE[\s\S]*?ADD COLUMN(?! IF NOT EXISTS)/);
    expect(stmts).toMatch(/CREATE INDEX IF NOT EXISTS "users_signup_source_idx"/);
    // 来源列不许带默认值:带了就等于给几百个存量账号盖上一个猜出来的来源,
    // 而后台要拿这一列做批量停用。
    expect(stmts).toMatch(/ADD COLUMN IF NOT EXISTS signup_source text;/);
  });
});
