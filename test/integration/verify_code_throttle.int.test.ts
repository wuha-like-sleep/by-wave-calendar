// 注册验证码的 (IP, 邮箱) 跨码节流：
//   - 每码 6 次上限只约束单个码，重发新码会把 attempts 清零 —— 第二层
//     按 (IP, 邮箱) 累计失败，攒到站点登录锁定阈值就锁定该组合；
//   - 锁定窗口内连正确码也拒绝（与登录锁定同口径）；
//   - 换个 IP 不受影响（锁不住邮箱主人）；验证成功清零；
//   - 重发新码不清第二层计数（清了就等于没有第二层）。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

const sentMails: { to: string; text: string }[] = [];
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async (a: { to: string; text: string }) => {
    sentMails.push(a);
    return { ok: true };
  }),
  isMailerEnabled: vi.fn(async () => true),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import { ensureSchema, resetDb } from "./harness.js";
import { issueCode, verifyCode, __resetVerifyCodeThrottleForTest } from "../../src/lib/email_verification.js";
import { getSettings, reloadSettings, updateSettings } from "../../src/lib/site_settings.js";

const PAYLOAD = { passwordHash: "x", displayName: null };
const IP_A = "203.0.113.10";
const IP_B = "198.51.100.20";

async function issueAndCapture(email: string): Promise<string> {
  sentMails.length = 0;
  const res = await issueCode(email, PAYLOAD);
  expect(res.ok).toBe(true);
  const mail = sentMails.find((m) => m.to === email);
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  expect(code, "验证码应出现在邮件正文里").toBeTruthy();
  return code!;
}

function wrongCode(real: string): string {
  return real === "000000" ? "000001" : "000000";
}

beforeAll(async () => { await ensureSchema(); });

beforeEach(async () => {
  await resetDb();
  __resetVerifyCodeThrottleForTest();
  reloadSettings();
  await getSettings();
  // 阈值调小到 3 方便测；口径仍是站点设置里的登录锁定那一套。
  await updateSettings({ lockoutEnabled: true, lockoutThreshold: 3, lockoutMinutes: 15 });
});

describe("验证码 (IP, 邮箱) 节流", () => {
  it("连续失败到阈值后锁定：同 IP 连正确码也拒，换 IP 立刻能过", async () => {
    const email = "victim@example.com";
    const code = await issueAndCapture(email);
    const wrong = wrongCode(code);
    for (let i = 0; i < 3; i++) {
      expect((await verifyCode(email, wrong, IP_A)).reason).toBe("wrong");
    }
    const blocked = await verifyCode(email, code, IP_A);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("too_many_attempts");
    // 邮箱主人从自己的网络来，不受攻击者 IP 的锁定影响。
    const fromHome = await verifyCode(email, code, IP_B);
    expect(fromHome.ok).toBe(true);
  });

  it("重发新码不清第二层计数：跨两个码攒满照样锁", async () => {
    const email = "spray@example.com";
    const code1 = await issueAndCapture(email);
    expect((await verifyCode(email, wrongCode(code1), IP_A)).reason).toBe("wrong");
    expect((await verifyCode(email, wrongCode(code1), IP_A)).reason).toBe("wrong");
    // 攻击者点「重新发送」拿到新码 —— 每码 attempts 清零了，第二层没有。
    const code2 = await issueAndCapture(email);
    expect((await verifyCode(email, wrongCode(code2), IP_A)).reason).toBe("wrong");
    const blocked = await verifyCode(email, code2, IP_A);
    expect(blocked.reason).toBe("too_many_attempts");
  });

  it("验证成功清零：错两次、对一次，如此往复永不触发锁定", async () => {
    const email = "human@example.com";
    for (let round = 0; round < 3; round++) {
      const code = await issueAndCapture(email);
      expect((await verifyCode(email, wrongCode(code), IP_A)).reason).toBe("wrong");
      expect((await verifyCode(email, wrongCode(code), IP_A)).reason).toBe("wrong");
      expect((await verifyCode(email, code, IP_A)).ok).toBe(true);
    }
  });

  it("站点关掉登录锁定时不启用第二层（设置说了算）", async () => {
    await updateSettings({ lockoutEnabled: false });
    const email = "nolock@example.com";
    const code = await issueAndCapture(email);
    // 每码上限是 6：错 5 次仍是 wrong，第 6 次错后 attempts 到顶。
    // 这里只断言不会提前被 (IP, 邮箱) 层拦下。
    for (let i = 0; i < 5; i++) {
      expect((await verifyCode(email, wrongCode(code), IP_A)).reason).toBe("wrong");
    }
    expect((await verifyCode(email, code, IP_A)).ok).toBe(true);
  });
});
