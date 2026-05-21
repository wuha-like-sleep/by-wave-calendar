import { env } from "../env.js";
import type { SendArgs } from "./mailer.js";

const brand = env.MAIL_FROM_NAME;

function baseLayout(opts: { title: string; preheader?: string; body: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(opts.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',sans-serif;color:#0f172a;">
    ${opts.preheader ? `<div style="display:none;font-size:1px;color:#f1f5f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escape(opts.preheader)}</div>` : ""}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#ffffff;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="display:inline-block;width:24px;height:24px;background:rgba(255,255,255,0.18);border-radius:6px;"></span>
                  <strong style="font-size:16px;letter-spacing:0.4px;">${escape(brand)}</strong>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                ${opts.body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5;">
                这封邮件由 ${escape(brand)} 自动发出，请勿直接回复。<br/>
                如果不是你本人操作，请忽略并尽快修改密码。
              </td>
            </tr>
          </table>
          <div style="margin-top:12px;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} ${escape(brand)} · 日历共享平台</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Verification code (register) ----------
export function verificationCodeMail(to: string, code: string): SendArgs {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const text = `${brand} 邮箱验证码\n\n你的验证码是：${code}\n该验证码 10 分钟内有效，请勿告诉任何人。\n\n如果不是你本人操作，可以忽略这封邮件。\n\n${baseUrl}`;
  const html = baseLayout({
    title: `${brand} 邮箱验证码`,
    preheader: `验证码 ${code}，10 分钟内有效`,
    body: `
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;font-weight:600;">📧 邮箱验证</h1>
      <p style="margin:0 0 20px;color:#475569;line-height:1.6;font-size:14px;">
        请在 ${escape(brand)} 注册页面输入下方验证码完成邮箱验证。
      </p>
      <div style="margin:24px 0;padding:28px 16px;background:linear-gradient(135deg,#eef2ff,#e0e7ff);border-radius:16px;text-align:center;">
        <div style="font-size:11px;color:#6366f1;letter-spacing:2px;text-transform:uppercase;font-weight:600;margin-bottom:8px;">VERIFICATION CODE</div>
        <span style="font-size:42px;letter-spacing:14px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#1e1b4b;font-weight:700;display:inline-block;padding-left:14px;">${escape(code)}</span>
        <div style="font-size:11px;color:#6366f1;margin-top:8px;">10 分钟内有效</div>
      </div>
      <p style="margin:20px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
        ⚠️ 请勿告诉任何人此验证码。如果不是你本人在注册，请忽略此邮件 —— 你的邮箱不会被注册。
      </p>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">
        来自：<a href="${baseUrl}" style="color:#6366f1;text-decoration:none;">${baseUrl.replace(/^https?:\/\//, "")}</a>
      </p>`,
  });
  return { to, subject: `【${brand}】邮箱验证码 ${code}`, html, text };
}

// ---------- Login alert ----------
export type LoginAlertCtx = {
  email: string;
  displayName?: string | null;
  loginAt: Date;
  ip: string;
  userAgent: string;
  method: "password" | "passkey" | "mfa";
  location?: string;
};

export function loginAlertMail(to: string, ctx: LoginAlertCtx): SendArgs {
  const timeStr = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(ctx.loginAt);
  const methodLabel = ctx.method === "passkey" ? "Passkey" : ctx.method === "mfa" ? "密码 + MFA" : "密码";
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");

  const text = `${brand} 登录提醒
你的账号 ${ctx.email} 刚刚登录：
- 时间：${timeStr}
- 方式：${methodLabel}
- IP：${ctx.ip}
${ctx.location ? `- 地点：${ctx.location}\n` : ""}- 浏览器：${ctx.userAgent}

如果不是你本人，请立刻：
1) 修改密码（${baseUrl}/app/settings）
2) 检查并撤销陌生 Passkey / 关闭 MFA 重新设置
`;

  const html = baseLayout({
    title: `${brand} 登录提醒`,
    preheader: `${ctx.email} 在 ${timeStr} 登录`,
    body: `
      <h1 style="margin:0 0 12px;font-size:18px;color:#0f172a;">检测到新的登录</h1>
      <p style="margin:0 0 16px;color:#475569;line-height:1.6;font-size:14px;">
        你的账号 <strong>${escape(ctx.email)}</strong> 刚刚成功登录。如果是你本人，可忽略这封邮件。
      </p>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 16px;">
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:80px;">时间</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escape(timeStr)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">方式</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escape(methodLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">IP 地址</td><td style="padding:6px 0;color:#0f172a;font-size:13px;font-family:'SF Mono',Menlo,monospace;">${escape(ctx.ip)}</td></tr>
        ${ctx.location ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">地点</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escape(ctx.location)}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;vertical-align:top;">浏览器</td><td style="padding:6px 0;color:#0f172a;font-size:13px;word-break:break-all;">${escape(ctx.userAgent)}</td></tr>
      </table>
      <div style="margin:16px 0;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;color:#9a3412;font-size:13px;line-height:1.6;">
        <strong>不是你？</strong> 立即<a href="${baseUrl}/app/settings" style="color:#9a3412;text-decoration:underline;">改密码</a>，并检查 Passkey / MFA 设置。
      </div>`,
  });
  return { to, subject: `【${brand}】新登录提醒 · ${methodLabel}`, html, text };
}

// ---------- Password reset ----------
export function passwordResetMail(to: string, token: string): SendArgs {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const link = `${baseUrl}/reset-password/${encodeURIComponent(token)}`;
  const text = `${brand} 密码重置\n\n你（或冒充你的人）请求重置密码。\n点击下面链接设置新密码（1 小时内有效，只能用一次）：\n${link}\n\n如果不是你本人，忽略这封邮件即可，账号不会有任何变化。`;
  const html = baseLayout({
    title: `${brand} 密码重置`,
    preheader: "1 小时内有效",
    body: `
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;font-weight:600;">🔑 重置密码</h1>
      <p style="margin:0 0 16px;color:#475569;line-height:1.6;font-size:14px;">
        你请求重置 ${escape(brand)} 账号的密码。点击下面按钮设置新密码 —— 链接 <strong>1 小时内有效</strong>，且只能用一次。
      </p>
      <p style="margin:24px 0;">
        <a href="${link}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">设置新密码</a>
      </p>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;word-break:break-all;">
        按钮没反应？复制下面链接到浏览器打开：<br/>
        <a href="${link}" style="color:#6366f1;text-decoration:underline;">${link}</a>
      </p>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
        ⚠️ 如果不是你本人请求的，忽略此邮件即可 —— 你的账号不会有任何变化。设置新密码后，<strong>所有已登录设备会被强制下线</strong>。
      </p>`,
  });
  return { to, subject: `【${brand}】重置密码`, html, text };
}

// ---------- Welcome email after register ----------
export function welcomeMail(to: string, displayName: string | null): SendArgs {
  const name = displayName || to.split("@")[0] || to;
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const text = `欢迎加入 ${brand}！\n你的账号已激活。前往 ${baseUrl}/app 创建你的第一个日历。`;
  const html = baseLayout({
    title: `欢迎加入 ${brand}`,
    preheader: "账号已激活",
    body: `
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${escape(name)}，欢迎！</h1>
      <p style="margin:0 0 16px;color:#475569;line-height:1.6;font-size:14px;">
        你的 ${escape(brand)} 账号已经激活。现在就可以创建日历、添加事件、生成订阅链接分享给朋友和家人。
      </p>
      <p style="margin:16px 0;">
        <a href="${baseUrl}/app" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">进入控制台</a>
      </p>
      <ul style="margin:16px 0;padding-left:18px;color:#475569;font-size:13px;line-height:1.8;">
        <li>支持 ICS 订阅 —— Apple/Google/Outlook 都能直接订阅你的日历</li>
        <li>支持 Passkey 免密登录 + TOTP 二次验证 —— 在设置里开启</li>
        <li>每次登录都会有邮件提醒，账号安全有保障</li>
      </ul>`,
  });
  return { to, subject: `欢迎加入 ${brand}`, html, text };
}
