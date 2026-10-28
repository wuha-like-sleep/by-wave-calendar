import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";

// 「管理员已停用原生 APP 同步」那句话里给的后台路径，必须是后台里真的点得到的那条。
//
// 以前写的是「网页后台 → 管理 → API & APPs →『打开 APP 登录』」—— 后台菜单里
// 没有「API & APPs」，页面上也没有叫「打开 APP 登录」的开关。App 用户把这句话
// 转给站长，站长照着找一圈找不到，只能以为是 App 坏了。
//
// 判据：消息里的每一级都要等于后台实际渲染出来的文字 ——
//   顶栏入口：nav.admin（src/views/partials/nav.ejs）
//   左侧菜单：/admin/api 那一项的 label（src/views/admin/_nav.ejs）
//   卡片标题：adminApi.apps.heading、开关文字：adminApi.apps.toggleLabel（src/views/admin/api.ejs）

const read = (p: string) => readFileSync(path.resolve(p), "utf8");

function appsDisabledMessage(): string {
  const src = read("src/routes/devices.ts");
  const m = /error:\s*"apps_disabled",\s*message:\s*"([^"]+)"/.exec(src);
  expect(m, "没在 devices.ts 里找到 apps_disabled 的 message —— 判据瞎了").not.toBeNull();
  return m![1]!;
}

describe("apps_disabled 提示里的后台路径", () => {
  it("页面上真的用了这几个文案键（presence —— 不然下面比的是没人显示的字）", () => {
    const api = read("src/views/admin/api.ejs");
    expect(api).toContain('t("adminApi.apps.heading")');
    expect(api).toContain('t("adminApi.apps.toggleLabel")');
    expect(read("src/views/partials/nav.ejs")).toContain('t("nav.admin")');
  });

  it("**每一级都是后台里真实的叫法**", () => {
    const nav = read("src/views/admin/_nav.ejs");
    const apiLabel = /href:\s*'\/admin\/api',\s*label:\s*'([^']+)'/.exec(nav)?.[1];
    expect(apiLabel, "后台菜单里没找到 /admin/api 那一项").toBeTruthy();
    const msg = appsDisabledMessage();
    expect(
      msg,
      "提示里给的后台路径和后台真实的菜单对不上 —— 站长照着找不到开关",
    ).toContain(`「${zhCN["nav.admin"]} → ${apiLabel} → ${zhCN["adminApi.apps.heading"]}」`);
    expect(msg, "提示里写的开关名和页面上那个开关的文字对不上").toContain(`「${zhCN["adminApi.apps.toggleLabel"]}」`);
  });
});
