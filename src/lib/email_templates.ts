import { env } from "../env.js";
import type { SendArgs } from "./mailer.js";

// Brand name shown in email headers/footers. Updated from site_settings on
// each settings load via updateBrandForEmails() so a site name change in
// /admin/site takes effect for the next email without restart.
let brand: string = env.MAIL_FROM_NAME;
export function updateBrandForEmails(siteName: string | null | undefined): void {
  brand = siteName?.trim() || env.MAIL_FROM_NAME;
}
/** Current site brand name (siteName, or MAIL_FROM_NAME default). Used by the
 *  .ics serializer so a self-hosted/white-labelled deploy stamps its own name. */
export function getBrandName(): string {
  return brand;
}

// Format a Date for display in a specific IANA zone. Used by every email
// that surfaces an event time so the recipient sees the wall-clock time
// the organizer intended (e.g. "上海下午6点", not the organizer's UTC
// equivalent re-interpreted in the receiver's locale).
function formatInZone(d: Date, tz: string, allDay: boolean): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: allDay ? undefined : "2-digit",
      minute: allDay ? undefined : "2-digit",
      hour12: false,
    }).format(d);
  } catch (_e) {
    // Bad/unknown TZ — fall back to UTC so the email still renders.
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: allDay ? undefined : "2-digit",
      minute: allDay ? undefined : "2-digit",
      hour12: false,
    }).format(d);
  }
}

// Friendly Chinese label for common IANA zones, plus a graceful fallback
// to "(City Name)" extracted from the IANA id for anything we don't
// have a translation for.
const TZ_LABELS: Record<string, string> = {
  "Asia/Shanghai": "上海时间", "Asia/Hong_Kong": "香港时间", "Asia/Taipei": "台北时间",
  "Asia/Tokyo": "东京时间", "Asia/Seoul": "首尔时间", "Asia/Singapore": "新加坡时间",
  "Asia/Bangkok": "曼谷时间", "Asia/Kolkata": "印度时间", "Asia/Dubai": "迪拜时间",
  "Europe/London": "伦敦时间", "Europe/Paris": "巴黎时间", "Europe/Berlin": "柏林时间",
  "Europe/Moscow": "莫斯科时间", "Europe/Madrid": "马德里时间", "Europe/Rome": "罗马时间",
  "America/New_York": "纽约时间", "America/Los_Angeles": "洛杉矶时间",
  "America/Chicago": "芝加哥时间", "America/Toronto": "多伦多时间",
  "America/Sao_Paulo": "圣保罗时间",
  "Australia/Sydney": "悉尼时间", "Australia/Melbourne": "墨尔本时间",
  "Australia/Perth": "珀斯时间",
  "Pacific/Auckland": "奥克兰时间", "Pacific/Honolulu": "夏威夷时间",
  "UTC": "UTC",
};
function zoneLabel(tz: string): string {
  if (TZ_LABELS[tz]) return TZ_LABELS[tz];
  // Fallback: extract trailing component, replace underscores with space.
  const tail = tz.split("/").pop() ?? tz;
  return `${tail.replace(/_/g, " ")} 时间`;
}

// ---------- Brand palette (admin-configurable) ----------
// Defaults match src/styles/input.css indigo (--brand-600 #4F46E5). Admins can
// override the primary color + footer tagline in /admin/email-templates;
// updateEmailBranding() is called from getSettings() so a change takes effect
// for the next email without a restart. The accent (gradient end / link color)
// is derived from the primary by mixing toward white.
const DEFAULT_BRAND_COLOR = "#4f46e5";
const DEFAULT_FOOTER_NOTE = "日历共享平台";
let brandColor = DEFAULT_BRAND_COLOR;
let accentColor = lighten(DEFAULT_BRAND_COLOR, 0.16);
let footerNote = DEFAULT_FOOTER_NOTE;
// The admin-uploaded logo (settings.logoUrl), if any. Used in the email header
// + as the sender-side mark. May be relative; resolved to absolute at use.
let uploadedLogoUrl: string | null = null;

/** Mix a #rrggbb color toward white by `amt` (0..1). Invalid input → returned as-is. */
function lighten(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const k = Math.max(0, Math.min(1, amt));
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  const to2 = (c: number) => c.toString(16).padStart(2, "0");
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

/** Normalize a user hex (#rgb or #rrggbb, with/without #) to #rrggbb, or null if invalid. */
export function normalizeHexColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) return `#${m[1]!.toLowerCase()}`;
  m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) { const c = m[1]!.toLowerCase(); return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`; }
  return null;
}

/** Apply admin-configured brand color + footer tagline + uploaded logo
 *  (called on settings load). */
export function updateEmailBranding(opts: { brandColor?: string | null; footerNote?: string | null; logoUrl?: string | null }): void {
  brandColor = normalizeHexColor(opts.brandColor) ?? DEFAULT_BRAND_COLOR;
  accentColor = lighten(brandColor, 0.16);
  footerNote = opts.footerNote?.trim() || DEFAULT_FOOTER_NOTE;
  uploadedLogoUrl = opts.logoUrl?.trim() || null;
}

type EmailBrandingSnapshot = { brand: string; brandColor: string; accentColor: string; footerNote: string };
function snapshotBranding(): EmailBrandingSnapshot { return { brand, brandColor, accentColor, footerNote }; }
function restoreBranding(s: EmailBrandingSnapshot): void {
  brand = s.brand; brandColor = s.brandColor; accentColor = s.accentColor; footerNote = s.footerNote;
}

/**
 * Render a template fn with TEMPORARY branding overrides, then restore the
 * previous values. Used by the admin live-preview so a draft can be rendered
 * WITHOUT persisting it. SAFE re: concurrency: `render` is fully synchronous
 * (the *Mail() builders never await), so no other request's code runs between
 * the override and the restore in `finally`.
 */
export function renderWithBranding(
  overrides: { brand?: string | null; brandColor?: string | null; footerNote?: string | null },
  render: () => SendArgs,
): SendArgs {
  const prev = snapshotBranding();
  try {
    if (overrides.brand != null && overrides.brand.trim()) brand = overrides.brand.trim();
    const c = normalizeHexColor(overrides.brandColor);
    if (c) { brandColor = c; accentColor = lighten(c, 0.16); }
    if (overrides.footerNote != null && overrides.footerNote.trim()) footerNote = overrides.footerNote.trim();
    return render();
  } finally {
    restoreBranding(prev);
  }
}

// Absolute, publicly-reachable URL to the platform logo. Email clients can't
// resolve relative paths, so we build a full URL from the site's own public
// base. @fastify/static serves src/public at the "/static/" prefix
// (see server.ts), so src/public/icons/icon-512.png is exposed at
// /static/icons/icon-512.png. Returns null if PUBLIC_BASE_URL is somehow
// unusable, in which case layout() falls back to a text-only brand title.
function brandLogoUrl(): string | null {
  const base = (env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  // Prefer the admin-uploaded logo (settings.logoUrl). It's usually relative
  // (e.g. "/static/uploads/logo.png?v=…"); email clients can't resolve relative
  // URLs, so make it absolute against PUBLIC_BASE_URL. Fall back to the bundled
  // app icon when no custom logo is set.
  if (uploadedLogoUrl) {
    if (/^https?:\/\//i.test(uploadedLogoUrl)) return uploadedLogoUrl;
    if (base) return base + (uploadedLogoUrl.startsWith("/") ? uploadedLogoUrl : "/" + uploadedLogoUrl);
  }
  if (!base) return null;
  return `${base}/static/icons/icon-512.png`;
}

// Shared, email-client-safe skeleton for every message we send. Table-based
// layout (no flex/grid), all styling inline (no <style>/external CSS), a
// brand-colored header with the platform logo + name, a content area, and a
// footer that names the platform and notes the mail is auto-sent.
function layout(opts: {
  title: string;
  preheader?: string;
  body: string;
  // Optional extra footer links (e.g. support / unsubscribe). Rendered as
  // " · "-separated anchors above the auto-send notice.
  footerLinks?: Array<{ label: string; url: string }>;
}): string {
  const logo = brandLogoUrl();
  const year = new Date().getFullYear();
  const links = (opts.footerLinks ?? []).filter((l) => l.url);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <title>${escape(opts.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',sans-serif;color:#0f172a;">
    ${opts.preheader ? `<div style="display:none;font-size:1px;color:#f1f5f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escape(opts.preheader)}</div>` : ""}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
            <tr>
              <td style="padding:22px 28px;background:${brandColor};background:linear-gradient(135deg,${brandColor},${accentColor});color:#ffffff;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    ${logo ? `<td style="vertical-align:middle;padding-right:10px;">
                      <img src="${logo}" width="32" height="32" alt="${escape(brand)}" style="display:block;width:32px;height:32px;border-radius:8px;border:0;background:rgba(255,255,255,0.18);" />
                    </td>` : ""}
                    <td style="vertical-align:middle;">
                      <strong style="font-size:17px;letter-spacing:0.4px;color:#ffffff;">${escape(brand)}</strong>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                ${opts.body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;">
                ${links.length ? `<div style="margin:0 0 8px;">${links.map((l) => `<a href="${l.url}" style="color:${brandColor};text-decoration:none;">${escape(l.label)}</a>`).join(`<span style="color:#cbd5e1;"> · </span>`)}</div>` : ""}
                此邮件由 ${escape(brand)} 自动发送，请勿直接回复。
              </td>
            </tr>
          </table>
          <div style="margin-top:12px;color:#94a3b8;font-size:12px;">© ${year} ${escape(brand)} · ${escape(footerNote)}</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Backwards-compatible alias: existing templates call baseLayout(). Keep the
// name so nothing below has to change beyond what we're intentionally editing.
function baseLayout(opts: { title: string; preheader?: string; body: string }): string {
  return layout(opts);
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
      <div style="margin:24px 0;padding:28px 16px;background:#0f172a;border-radius:16px;text-align:center;">
        <div style="font-size:11px;color:#a5b4fc;letter-spacing:2px;text-transform:uppercase;font-weight:600;margin-bottom:10px;">VERIFICATION CODE</div>
        <span style="font-size:44px;letter-spacing:14px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#ffffff;font-weight:700;display:inline-block;padding-left:14px;">${escape(code)}</span>
        <div style="font-size:11px;color:#a5b4fc;margin-top:10px;">10 分钟内有效</div>
      </div>
      <p style="margin:20px 0 0;color:#475569;font-size:12px;line-height:1.6;">
        ⚠️ 请勿告诉任何人此验证码。如果不是你本人在注册，请忽略此邮件 —— 你的邮箱不会被注册。
      </p>
      <p style="margin:16px 0 0;color:#64748b;font-size:12px;">
        来自：<a href="${baseUrl}" style="color:${brandColor};text-decoration:none;font-weight:500;">${escape(brand)}</a>
      </p>`,
  });
  return { to, subject: `【${brand}】邮箱验证码 ${code}`, html, text };
}

// ---------- Login challenge code (new device / unfamiliar IP) ----------
export function loginChallengeMail(to: string, code: string, ctx: { ip: string; userAgent: string }): SendArgs {
  const text = `${brand} 安全验证码\n\n检测到陌生设备 / IP 登录，请用下方验证码完成登录：\n${code}\n\n10 分钟内有效。IP: ${ctx.ip}\n\n如果不是你本人操作，立即修改密码。`;
  const html = baseLayout({
    title: `${brand} 安全验证`,
    preheader: `登录验证码 ${code}（10 分钟内有效）`,
    body: `
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;font-weight:600;">🛡 陌生设备登录</h1>
      <p style="margin:0 0 20px;color:#475569;line-height:1.6;font-size:14px;">
        我们检测到这次登录来自不熟悉的 IP 或浏览器 —— 输入下方验证码完成本次登录。如果<strong>不是你本人</strong>，立即修改密码。
      </p>
      <div style="margin:24px 0;padding:28px 16px;background:#78350f;border-radius:16px;text-align:center;">
        <div style="font-size:11px;color:#fed7aa;letter-spacing:2px;text-transform:uppercase;font-weight:600;margin-bottom:10px;">LOGIN CODE</div>
        <span style="font-size:44px;letter-spacing:14px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#ffffff;font-weight:700;display:inline-block;padding-left:14px;">${escape(code)}</span>
        <div style="font-size:11px;color:#fed7aa;margin-top:10px;">10 分钟内有效</div>
      </div>
      <p style="margin:14px 0 0;color:#64748b;font-size:12px;line-height:1.6;">
        IP <code style="font-family:'SF Mono',monospace;">${escape(ctx.ip)}</code> · ${escape(ctx.userAgent.slice(0, 80))}
      </p>
      <p style="margin:16px 0 0;color:#64748b;font-size:12px;">
        来自：<a href="${env.PUBLIC_BASE_URL.replace(/\/$/, "")}" style="color:${brandColor};text-decoration:none;font-weight:500;">${escape(brand)}</a>
      </p>`,
  });
  return { to, subject: `【${brand}】登录验证码 ${code}`, html, text };
}

// ---------- Login alert ----------
export type LoginAlertCtx = {
  email: string;
  displayName?: string | null;
  loginAt: Date;
  ip: string;
  userAgent: string;
  method: "password" | "passkey" | "mfa" | "sso" | "qr";
  location?: string;
};

export function loginAlertMail(to: string, ctx: LoginAlertCtx): SendArgs {
  const timeStr = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(ctx.loginAt);
  const methodLabel = ctx.method === "passkey" ? "Passkey" : ctx.method === "mfa" ? "密码 + MFA" : ctx.method === "sso" ? "SSO" : ctx.method === "qr" ? "手机扫码授权" : "密码";
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
        <a href="${link}" style="display:inline-block;background:${brandColor};color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">设置新密码</a>
      </p>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;word-break:break-all;">
        按钮没反应？复制下面链接到浏览器打开：<br/>
        <a href="${link}" style="color:${accentColor};text-decoration:underline;">${link}</a>
      </p>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
        ⚠️ 如果不是你本人请求的，忽略此邮件即可 —— 你的账号不会有任何变化。设置新密码后，<strong>所有已登录设备会被强制下线</strong>。
      </p>`,
  });
  return { to, subject: `【${brand}】重置密码`, html, text };
}

// ---------- Event invitation (with ICS attachment) ----------
export type EventInviteCtx = {
  organizerEmail: string;
  organizerName: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  uid: string;
  // IANA zone, e.g. "Asia/Shanghai" or "America/New_York". When set, the
  // email formats times in this zone and shows a "(上海时间)" suffix.
  // Defaults to Asia/Shanghai (kept for backward compat with old call sites).
  timezone?: string | null;
  icsBody: string; // full VCALENDAR text with METHOD:REQUEST
  inviteToken?: string; // opaque token → /event-invite/:token page that imports into the recipient's chosen calendar
  meetingUrl?: string | null; // a join/conference link → renders the "meeting" variant
};

// A meeting (vs a plain event) when the link points at a known conferencing
// host — covers the common global + CN platforms. Drives the 📹 / 加入会议 styling.
function looksLikeMeetingUrl(url: string): boolean {
  return /(?:zoom\.us|meet\.google\.com|teams\.(?:microsoft|live)\.com|webex\.com|meeting\.tencent\.com|voovmeeting\.com|feishu\.cn|larksuite\.com|dingtalk\.com|whereby\.com|gotomeeting\.com|bluejeans\.com|meet\.jit\.si)/i.test(url);
}

export function eventInviteMail(to: string, ctx: EventInviteCtx): SendArgs {
  const tz = ctx.timezone || "Asia/Shanghai";
  const fmt = (d: Date) => formatInZone(d, tz, !!ctx.allDay);
  const tzLabel = zoneLabel(tz);
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  // Only http(s) links become a button (the API validates extra.url, but never
  // trust an inbound value — guard the scheme so no javascript:/data: slips in).
  const meetingUrl = ctx.meetingUrl && /^https?:\/\//i.test(ctx.meetingUrl) ? ctx.meetingUrl : null;
  const isMeeting = !!meetingUrl && looksLikeMeetingUrl(meetingUrl);
  const heading = isMeeting ? "📹 会议邀请" : "📅 事件邀请";
  const joinLabel = isMeeting ? "📹 加入会议" : "🔗 打开链接";
  const text = `${ctx.organizerName} 邀请你参加：${ctx.summary}\n时间：${fmt(ctx.startsAt)} — ${fmt(ctx.endsAt)}（${tzLabel}）\n${meetingUrl ? `${isMeeting ? "会议链接" : "链接"}：${meetingUrl}\n` : ""}${ctx.location ? `地点：${ctx.location}\n` : ""}${ctx.description ? `\n${ctx.description}\n` : ""}\n附件中是 .ics 文件，导入后将按你日历的时区显示。`;
  const html = baseLayout({
    title: ctx.summary,
    preheader: `${ctx.organizerName} 邀请你参加 ${ctx.summary}`,
    body: `
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${heading}</h1>
      <p style="margin:0 0 6px;color:#0f172a;font-size:16px;font-weight:600;">${escape(ctx.summary)}</p>
      <p style="margin:0 0 14px;color:#475569;font-size:14px;">
        ${escape(ctx.organizerName)} 邀请你参加${isMeeting ? "这场会议" : (ctx.allDay ? "这场全天活动" : "这场活动")}。
      </p>
      ${meetingUrl ? `
      <p style="margin:8px 0 4px;">
        <a href="${escape(meetingUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">${joinLabel}</a>
      </p>
      <p style="margin:2px 0 12px;color:#94a3b8;font-size:12px;word-break:break-all;">${escape(meetingUrl)}</p>
      ` : ""}
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 14px;">
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:60px;">开始</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escape(fmt(ctx.startsAt))} <span style="color:#94a3b8;font-size:11px;">${escape(tzLabel)}</span></td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">结束</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escape(fmt(ctx.endsAt))} <span style="color:#94a3b8;font-size:11px;">${escape(tzLabel)}</span></td></tr>
        ${ctx.location ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">地点</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escape(ctx.location)}</td></tr>` : ""}
      </table>
      ${ctx.description ? `<div style="margin:14px 0;padding:12px 14px;background:#f8fafc;border-left:3px solid ${accentColor};border-radius:6px;color:#334155;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escape(ctx.description)}</div>` : ""}
      ${ctx.inviteToken ? `
      <p style="margin:18px 0 10px;">
        <a href="${baseUrl}/event-invite/${encodeURIComponent(ctx.inviteToken)}"
           style="display:inline-block;background:${brandColor};color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">
          添加到我的日历
        </a>
      </p>
      <p style="margin:8px 0 14px;color:#94a3b8;font-size:12px;">点上面按钮跳转 ${escape(brand)} 网页，可选择加入哪个日历；或者用附件 .ics 加到任何外部客户端。</p>
      ` : `
      <p style="margin:18px 0 10px;color:#475569;font-size:13px;line-height:1.6;">
        附件中的 <strong>invite.ics</strong> 可以直接被 Apple / Google / Outlook 日历识别 ——
        点开即可"添加到日历"。如果客户端没自动弹窗，直接双击附件即可导入。
      </p>`}
      <p style="margin:10px 0 0;color:#64748b;font-size:12px;">
        来自：<a href="${baseUrl}" style="color:${brandColor};text-decoration:none;font-weight:500;">${escape(brand)}</a>
      </p>`,
  });
  return {
    to, subject: `${isMeeting ? "【会议】" : "【邀请】"}${ctx.summary}`,
    html, text,
    icalEvent: { method: "REQUEST", content: ctx.icsBody },
    attachments: [{ filename: "invite.ics", content: ctx.icsBody, contentType: "text/calendar; charset=utf-8; method=REQUEST" }],
  };
}

// ---------- Event cancellation (organizer deleted) ----------
export function eventCancelMail(to: string, ctx: {
  organizerEmail: string;
  organizerName: string;
  summary: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  // Optional IANA zone — same semantics as eventInviteMail.
  timezone?: string | null;
  icsBody: string; // VCALENDAR with METHOD:CANCEL
}): SendArgs {
  const tz = ctx.timezone || "Asia/Shanghai";
  const fmt = (d: Date) => formatInZone(d, tz, !!ctx.allDay);
  const tzLabel = zoneLabel(tz);
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const text = `${ctx.organizerName} 取消了活动：${ctx.summary}\n原定时间：${fmt(ctx.startsAt)} — ${fmt(ctx.endsAt)}（${tzLabel}）\n\n附件 .ics 是取消通知（METHOD:CANCEL），客户端会自动从你的日历移除这场活动。`;
  const html = baseLayout({
    title: `已取消：${ctx.summary}`,
    preheader: `${ctx.organizerName} 取消了 ${ctx.summary}`,
    body: `
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">❌ 活动已取消</h1>
      <p style="margin:0 0 6px;color:#0f172a;font-size:16px;font-weight:600;text-decoration:line-through;text-decoration-color:#cbd5e1;">${escape(ctx.summary)}</p>
      <p style="margin:0 0 14px;color:#475569;font-size:14px;">
        <strong>${escape(ctx.organizerName)}</strong> 取消了这场活动。
      </p>
      <div style="margin:14px 0;padding:12px 14px;background:#fff1f2;border:1px solid #fecaca;border-radius:10px;color:#9f1239;font-size:13px;line-height:1.6;">
        原定时间：${escape(fmt(ctx.startsAt))} — ${escape(fmt(ctx.endsAt))} <span style="color:#fb7185;font-size:11px;">${escape(tzLabel)}</span>
      </div>
      <p style="margin:14px 0 0;color:#64748b;font-size:13px;line-height:1.6;">
        附件 <strong>invite.ics</strong> 是 METHOD:CANCEL 的标准取消通知 —— Apple / Google /
        Outlook 日历看到这条会自动把对应事件从你的日历里移除（如果你之前接受过）。
      </p>
      <p style="margin:14px 0 0;color:#64748b;font-size:12px;">
        来自：<a href="${baseUrl}" style="color:${brandColor};text-decoration:none;font-weight:500;">${escape(brand)}</a>
      </p>`,
  });
  return {
    to, subject: `【已取消】${ctx.summary}`,
    html, text,
    icalEvent: { method: "CANCEL", content: ctx.icsBody },
    attachments: [{ filename: "invite.ics", content: ctx.icsBody, contentType: "text/calendar; charset=utf-8; method=CANCEL" }],
  };
}

// ---------- Calendar invitation ----------
export function calendarInviteMail(
  to: string,
  ctx: { calendarName: string; inviterName: string; role: string; message: string | null; token: string },
): SendArgs {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const acceptUrl = `${baseUrl}/invite/${encodeURIComponent(ctx.token)}`;
  const roleLabel = ctx.role === "editor" ? "可编辑" : "只读查看";
  const text = `${ctx.inviterName} 邀请你加入日历「${ctx.calendarName}」（${roleLabel}）。\n${ctx.message ? `\n留言：${ctx.message}\n` : ""}\n接受邀请：${acceptUrl}\n7 天内有效。`;
  const html = baseLayout({
    title: `邀请加入「${ctx.calendarName}」`,
    preheader: `${ctx.inviterName} 邀请你加入日历`,
    body: `
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">📅 日历协作邀请</h1>
      <p style="margin:0 0 14px;color:#475569;line-height:1.6;font-size:14px;">
        <strong>${escape(ctx.inviterName)}</strong> 邀请你加入日历 <strong>「${escape(ctx.calendarName)}」</strong>，权限：<strong>${escape(roleLabel)}</strong>。
      </p>
      ${ctx.message ? `<div style="margin:14px 0;padding:12px 14px;background:#f8fafc;border-left:3px solid ${accentColor};border-radius:6px;color:#334155;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escape(ctx.message)}</div>` : ""}
      <p style="margin:20px 0 14px;">
        <a href="${acceptUrl}" style="display:inline-block;background:${brandColor};color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">接受邀请</a>
      </p>
      <p style="margin:14px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;word-break:break-all;">
        按钮没反应？复制下面链接到浏览器：<br/>
        <a href="${acceptUrl}" style="color:${accentColor};text-decoration:underline;">${acceptUrl}</a>
      </p>
      <p style="margin:14px 0 0;color:#94a3b8;font-size:12px;">
        邀请 7 天内有效。如果还没注册，按下「接受邀请」会引导你注册同邮箱账号后自动加入。
      </p>`,
  });
  return { to, subject: `【${brand}】邀请你加入日历「${ctx.calendarName}」`, html, text };
}

// ---------- Security alert: 2FA / Passkey enabled ----------
export function securityChangeMail(to: string, ctx: { kind: "passkey_added" | "mfa_enabled" | "mfa_disabled" | "password_changed"; deviceName?: string | null }): SendArgs {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const label = ctx.kind === "passkey_added" ? "Passkey 已添加"
              : ctx.kind === "mfa_enabled"   ? "二次验证 (TOTP) 已启用"
              : ctx.kind === "mfa_disabled"  ? "二次验证 (TOTP) 已关闭"
              :                                "密码已修改";
  const emoji = ctx.kind === "passkey_added" ? "🔐"
              : ctx.kind === "mfa_enabled"   ? "🛡️"
              : ctx.kind === "mfa_disabled"  ? "⚠️"
              :                                "🔑";
  const description = ctx.kind === "passkey_added" ? `你刚刚为账号添加了一把新的 Passkey${ctx.deviceName ? `「${ctx.deviceName}」` : ""}。今后登录时即可用指纹 / Face ID / 设备锁直接通过。`
              : ctx.kind === "mfa_enabled"   ? "你刚刚启用了 TOTP 二次验证。今后登录需要密码 + 认证器 6 位验证码（除非使用 Passkey）。请把备用码妥善保存到密码管理器。"
              : ctx.kind === "mfa_disabled"  ? "你刚刚关闭了 TOTP 二次验证 —— 登录从此只需密码（或 Passkey）。如果不是你本人操作，立即修改密码！"
              :                                "你刚刚修改了账号密码 —— 所有已登录设备都已被强制下线，需要使用新密码重新登录。";
  const isWarning = ctx.kind === "mfa_disabled";
  const text = `${label}\n\n${description}\n\n如果不是你本人操作，立即前往 ${baseUrl}/app/settings 检查账号安全。`;
  const html = baseLayout({
    title: label,
    preheader: description.slice(0, 100),
    body: `
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${emoji} ${escape(label)}</h1>
      <p style="margin:0 0 14px;color:#475569;line-height:1.6;font-size:14px;">${escape(description)}</p>
      ${isWarning ? `
      <div style="margin:14px 0;padding:12px 14px;background:#fff1f2;border:1px solid #fecaca;border-radius:10px;color:#9f1239;font-size:13px;line-height:1.6;">
        <strong>不是你？</strong> 立即<a href="${baseUrl}/forgot-password" style="color:#9f1239;text-decoration:underline;">重置密码</a>，所有设备会被踢出登录。
      </div>` : `
      <p style="margin:14px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
        如果不是你本人操作，立即<a href="${baseUrl}/forgot-password" style="color:${accentColor};text-decoration:underline;">重置密码</a>。
      </p>`}
      <p style="margin:14px 0 0;">
        <a href="${baseUrl}/app/settings" style="display:inline-block;background:${brandColor};color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;">查看账号设置</a>
      </p>`,
  });
  return { to, subject: `【${brand}】${label}`, html, text };
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
        <a href="${baseUrl}/app" style="display:inline-block;background:${brandColor};color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">进入控制台</a>
      </p>
      <ul style="margin:16px 0;padding-left:18px;color:#475569;font-size:13px;line-height:1.8;">
        <li>支持 ICS 订阅 —— Apple/Google/Outlook 都能直接订阅你的日历</li>
        <li>支持 Passkey 免密登录 + TOTP 二次验证 —— 在设置里开启</li>
        <li>每次登录都会有邮件提醒，账号安全有保障</li>
      </ul>`,
  });
  return { to, subject: `欢迎加入 ${brand}`, html, text };
}

// ---------- Signup invitation (invite a new person to register) ----------
// New template (added for the registration-invite flow). The caller supplies
// the platform name explicitly so the visible copy stays correct even if this
// is rendered before site_settings has primed updateBrandForEmails(); the
// header/footer logo + name still come from the shared layout() (module brand).
export function inviteSignupMail(args: {
  to: string;
  inviteUrl: string;
  siteName: string;
  inviterName?: string;
}): SendArgs {
  const { to, inviteUrl, siteName } = args;
  const name = (siteName || "").trim() || brand;
  const inviter = args.inviterName?.trim();
  const text = `${inviter ? `${inviter} 邀请你加入 ${name}` : `邀请你加入 ${name}`}\n\n${name}（${footerNote}）可以创建日历、添加事件、生成订阅链接分享给朋友和家人。\n点击下面链接完成注册（链接可能有时效，请尽快使用）：\n${inviteUrl}\n\n如果你并不认识邀请人，可以直接忽略这封邮件。`;
  const html = layout({
    title: `${inviter ? `${inviter} 邀请你加入 ${name}` : `邀请你加入 ${name}`}`,
    preheader: `${inviter ? `${inviter} 邀请你注册 ${name}` : `邀请你注册 ${name}`}`,
    body: `
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;font-weight:600;">✉️ 注册邀请</h1>
      <p style="margin:0 0 14px;color:#475569;line-height:1.6;font-size:14px;">
        ${inviter ? `<strong>${escape(inviter)}</strong> 邀请你加入 <strong>${escape(name)}</strong>。` : `你被邀请加入 <strong>${escape(name)}</strong>。`}
        ${escape(footerNote)} —— 创建日历、添加事件，并把订阅链接分享给朋友和家人。
      </p>
      <p style="margin:22px 0 14px;">
        <a href="${inviteUrl}" style="display:inline-block;background:${brandColor};color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">接受邀请并注册</a>
      </p>
      <p style="margin:14px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;word-break:break-all;">
        按钮没反应？复制下面链接到浏览器打开：<br/>
        <a href="${inviteUrl}" style="color:${accentColor};text-decoration:underline;">${inviteUrl}</a>
      </p>
      <p style="margin:14px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
        如果你并不认识邀请人，可以直接忽略这封邮件 —— 不会有任何账号被创建。
      </p>`,
  });
  return { to, subject: `【${name}】邀请你注册`, html, text };
}

// ---------- Admin preview registry ----------
// Every user-facing template with representative sample data, so the admin
// "邮件模板" page can render each one (and the live brand-color preview). The
// `build` fns are only called when previewing/sending a test — never in normal
// flows. `now` is injected so the preview is deterministic per request.
export type EmailPreviewTemplate = {
  key: string;
  label: string;
  build: (to: string, now: Date) => SendArgs;
};

export const EMAIL_PREVIEW_TEMPLATES: ReadonlyArray<EmailPreviewTemplate> = [
  { key: "verification", label: "邮箱验证码（注册）", build: (to) => verificationCodeMail(to, "123456") },
  { key: "welcome", label: "欢迎邮件", build: (to) => welcomeMail(to, "示例用户") },
  { key: "passwordReset", label: "密码重置", build: (to) => passwordResetMail(to, "demo-token-not-real-zG7yQpKxL3mN9vBdE2hRsT4uW6f") },
  { key: "loginChallenge", label: "陌生设备验证码", build: (to) => loginChallengeMail(to, "508231", { ip: "203.0.113.42", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)" }) },
  {
    key: "loginAlert", label: "新登录提醒",
    build: (to, now) => loginAlertMail(to, {
      email: to, displayName: "示例用户", loginAt: now, ip: "203.0.113.42",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15",
      method: "password", location: "上海",
    }),
  },
  { key: "securityChange", label: "安全变更（启用 MFA）", build: (to) => securityChangeMail(to, { kind: "mfa_enabled" }) },
  {
    key: "calendarInvite", label: "日历协作邀请",
    build: (to) => calendarInviteMail(to, {
      calendarName: "工作日历", inviterName: "示例管理员", role: "editor",
      message: "把这个加进你的日历，每周一会议都在这里。", token: "demo-invitation-token",
    }),
  },
  {
    key: "inviteSignup", label: "注册邀请",
    build: (to) => inviteSignupMail({
      to, inviteUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/register?invite=demo-token`,
      siteName: brand, inviterName: "示例管理员",
    }),
  },
  {
    key: "meetingInvite", label: "会议邀请（含加入链接）",
    build: (to, now) => {
      const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const dt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ByWave//Preview//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:preview-meeting@bywave\r\nDTSTAMP:${dt(now)}\r\nDTSTART:${dt(start)}\r\nDTEND:${dt(end)}\r\nSUMMARY:产品周会\r\nEND:VEVENT\r\nEND:VCALENDAR`;
      return eventInviteMail(to, {
        organizerEmail: "host@example.com", organizerName: "示例主持人",
        summary: "产品周会", description: "议程：上周进展 / 本周计划 / 风险项",
        location: "线上", startsAt: start, endsAt: end, allDay: false,
        uid: "preview-meeting@bywave", timezone: "Asia/Shanghai",
        meetingUrl: "https://meeting.tencent.com/dm/AbCdEf123456",
        icsBody: ics,
      });
    },
  },
];

/** Render a single preview template by key with optional draft branding overrides. Returns full HTML, or null if the key is unknown. */
export function renderPreviewHtml(
  key: string,
  to: string,
  now: Date,
  overrides: { brand?: string | null; brandColor?: string | null; footerNote?: string | null },
): string | null {
  const tpl = EMAIL_PREVIEW_TEMPLATES.find((t) => t.key === key);
  if (!tpl) return null;
  return renderWithBranding(overrides, () => tpl.build(to, now)).html;
}
