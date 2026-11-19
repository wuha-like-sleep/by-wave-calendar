// 安全变更邮件补上 api_token 类型之后的断言：
//   1) 创建 / 撤销两种通知都能渲染，收件人能看懂「哪个 token、什么权限、
//      何时到期、是谁动的」；
//   2) 红线：邮件里只有打码的 prefix，绝不能出现完整 token 形状的字符串 ——
//      明文只在创建页面显示一次，邮件是长期留存物。

import { describe, it, expect } from "vitest";
import { securityChangeMail, EMAIL_PREVIEW_TEMPLATES } from "../src/lib/email_templates.js";

const FULL_TOKEN_SHAPE = /bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/;

describe("securityChangeMail — api_token kinds", () => {
  it("自助创建：主题点名 API Token，正文带标签 / 打码 prefix / 权限 / 永不过期", () => {
    const m = securityChangeMail("owner@example.com", {
      kind: "api_token_created",
      token: { label: "n8n 同步", prefix: "Ab3dEf7h", scope: "read", expiresAt: null, via: "self_service" },
    });
    expect(m.to).toBe("owner@example.com");
    expect(m.subject).toContain("API Token 已创建");
    expect(m.text).toContain("n8n 同步");
    expect(m.text).toContain("bwc_Ab3dEf7h_…");
    expect(m.text).toContain("只读");
    expect(m.text).toContain("永不过期");
    expect(m.html + m.text).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("管理员创建：正文说明是管理员所为，并带到期时间", () => {
    const m = securityChangeMail("owner@example.com", {
      kind: "api_token_created",
      token: {
        label: "内部系统", prefix: "Zz9Yy8Xx", scope: "write",
        expiresAt: new Date("2027-01-15T00:00:00Z"), via: "admin",
      },
    });
    expect(m.text).toContain("管理员刚刚为你的账号新建了");
    expect(m.text).toContain("可读写");
    expect(m.text).toContain("2027");
    expect(m.html + m.text).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("撤销：自助与管理员两种说法都成立，且不带明文形状", () => {
    const self = securityChangeMail("owner@example.com", {
      kind: "api_token_revoked",
      token: { label: "旧集成", prefix: "Qw12Er34", scope: "write", expiresAt: null, via: "self_service" },
    });
    expect(self.subject).toContain("API Token 已撤销");
    expect(self.text).toContain("即刻失效");

    const byAdmin = securityChangeMail("owner@example.com", {
      kind: "api_token_revoked",
      token: { label: "旧集成", prefix: "Qw12Er34", scope: "write", expiresAt: null, via: "admin" },
    });
    expect(byAdmin.text).toContain("管理员刚刚撤销了");
    expect(byAdmin.html + byAdmin.text).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("老类型不受影响；预览注册表里有 token 模板且可渲染", () => {
    const mfa = securityChangeMail("owner@example.com", { kind: "mfa_enabled" });
    expect(mfa.subject).toContain("二次验证 (TOTP) 已启用");
    const preview = EMAIL_PREVIEW_TEMPLATES.find((t) => t.key === "securityChangeToken");
    expect(preview).toBeTruthy();
    const rendered = preview!.build("owner@example.com", new Date());
    expect(rendered.subject).toContain("API Token 已创建");
    expect(rendered.html + rendered.text).not.toMatch(FULL_TOKEN_SHAPE);
  });
});
