// Server-side i18n. EJS templates and route handlers call `t(req, key)`
// or rely on the auto-injected `t()` view local. The translation
// dictionaries below are flat string maps; missing keys fall back to
// the English value, then to the key itself (so an untranslated
// surface degrades to a readable, machine-greppable label rather than
// breaking the page).
//
// Resolution order per request, highest priority first:
//
//   1. Cookie `bwc_locale` — explicit override the user set via the
//      language switcher on /login or /app/settings. Wins over the
//      logged-in user's saved locale because it represents the user's
//      "right now" intent (e.g. they're on a public computer or
//      borrowing someone else's account temporarily).
//   2. user.locale       — logged-in user's saved preference
//   3. site default      — site_settings.default_locale (admin choice)
//                           If site default is "auto", treat as fallthrough.
//   4. Accept-Language   — best-effort sniff from the request header
//   5. "zh-CN"           — hard fallback
//
// Adding a language:
//   - Add a new entry to LOCALES with { code, label, labelEn }
//   - Add a new dictionary block to DICTIONARIES keyed by the code
//   - Update src/db/schema.ts SUPPORTED_LOCALES comment if needed
//   - Translate as much of `zhCN` below as you can (English fallback
//     covers the rest)

import type { FastifyRequest } from "fastify";

/** Supported locale tags. Order here = order shown in the picker. */
export const LOCALES = [
  { code: "zh-CN", label: "简体中文", labelEn: "Chinese (Simplified)" },
  { code: "en", label: "English", labelEn: "English" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

/** "auto" is special — only valid as the site default. Means "detect
 *  from browser Accept-Language at request time." */
export const SITE_LOCALE_OPTIONS = [
  { code: "auto", label: "跟随浏览器", labelEn: "Follow browser" },
  ...LOCALES,
] as const;

/** Validate that a string is one of the supported locale codes. Used
 *  before persisting to DB or setting the bwc_locale cookie. */
export function isValidLocale(s: unknown): s is LocaleCode {
  return typeof s === "string" && LOCALES.some((l) => l.code === s);
}

export function isValidSiteLocale(s: unknown): s is "auto" | LocaleCode {
  return typeof s === "string" && (s === "auto" || isValidLocale(s));
}

/**
 * Translation dictionaries. The English dict (`en`) is the source of
 * truth — keys MUST exist there; other locales are allowed to omit
 * keys and fall back to English.
 *
 * Namespace conventions:
 *   common.*    — buttons, generic words used everywhere
 *   nav.*       — top-nav + footer
 *   login.*     — /login page
 *   register.*  — /register page
 *   settings.*  — /app/settings page
 *   admin.*     — /admin/* pages
 *   error.*     — error views
 */
const en: Record<string, string> = {
  // common
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.confirm": "Confirm",
  "common.back": "Back",
  "common.continue": "Continue",
  "common.required": "required",

  // nav
  "nav.calendar": "Calendar",
  "nav.search": "Search",
  "nav.settings": "Settings",
  "nav.admin": "Admin",
  "nav.signOut": "Sign out",
  "nav.signIn": "Sign in",
  "nav.register": "Sign up",
  "footer.tagline": "Self-hosted calendar sharing platform",
  "footer.openSource": "Open source",

  // login
  "login.title": "Sign in",
  "login.subtitle.withQr": "Sign in with password / Passkey, or scan from phone APP",
  "login.subtitle.noQr": "Sign in with password or Passkey",
  "login.tabPassword": "Password",
  "login.tabQr": "Scan QR",
  "login.passkeyButton": "Sign in with Passkey",
  "login.passkeyWaiting": "Waiting for Passkey…",
  "login.email": "Email",
  "login.password": "Password",
  "login.forgotPassword": "Forgot password?",
  "login.submit": "Sign in",
  "login.rememberMe": "Stay signed in (30 days)",
  "login.rememberMeHint": "· otherwise sign out when browser closes",
  "login.noAccount": "No account yet?",
  "login.qrLoading": "Generating QR code…",
  "login.qrInstructions": "Open the <strong>ByWave Calendar</strong> mobile APP, tap <em>Settings → Scan to sign in on web</em>, and scan the code above.",
  "login.qrWaiting": "Waiting for phone to approve…",
  "login.qrApproved": "✓ Approved — redirecting…",
  "login.qrExpired": "QR code expired",
  "login.qrDenied": "Authorization denied",
  "login.qrError": "Failed to generate QR code — please refresh",
  "login.qrFallback": "Phone APP needs to sign in once with password / Passkey first · then scanning works",
  "login.qrRefresh": "Generate a new QR code",
  "login.qrAdminDisabled": "Admin has disabled web scan-to-sign-in. Please use password.",

  // settings - language section
  "settings.languageTitle": "Language",
  "settings.languageDesc": "Choose the language for the web UI. This is per-account and overrides the site default.",
  "settings.languageFollowSite": "Follow site default",
  "settings.languageSaveSuccess": "Language updated",

  // admin - site language
  "admin.siteLanguageTitle": "Site language",
  "admin.siteLanguageDesc": "Default UI language for visitors and users who haven't set their own preference.",
  "admin.siteLanguageSaveSuccess": "Site language updated",

  // register
  "register.title": "Create account",
  "register.subtitle": "Free to use, no credit card required",
  "register.verifyNotice": "📨 After you submit, we'll email you a 6-digit code. Enter the code to activate your account.",
  "register.emailLabel": "Email",
  "register.displayNameLabel": "Display name (optional)",
  "register.passwordLabel": "Password",
  "register.passwordHint": "At least 8 characters; mixing letters and numbers is recommended",
  "register.submit": "Create account",
  "register.haveAccount": "Already have an account?",
  "register.signIn": "Sign in",

  // reset password
  "resetPassword.title": "Set a new password",
  "resetPassword.subtitle": "Set a new password for your account (at least 8 characters). All currently signed-in devices will be signed out.",
  "resetPassword.newPasswordLabel": "New password",
  "resetPassword.confirmLabel": "Confirm",
  "resetPassword.submit": "Set new password",
  "resetPassword.linkExpired": "Link expired?",
  "resetPassword.requestAgain": "Request again",

  // calendar view
  "calendar.breadcrumb.myCalendars": "My calendars",
  "calendar.timezone": "Timezone {tz}",
  "calendar.deleteCalendar.confirm": "Delete this entire calendar? This can't be undone.",
  "calendar.deleteCalendar.title": "Delete calendar",
  "calendar.deleteCalendar.ok": "Delete calendar",
  "calendar.deleteCalendar.button": "Delete calendar",
  "calendar.expand": "Expand ▾",
  "calendar.invite.heading": "👥 Invite collaborators",
  "calendar.invite.memberCount": "· {count} members",
  "calendar.invite.intro": "Invite people by email to join this calendar. Once they accept, it shows up in their calendar list.",
  "calendar.invite.emailPlaceholder": "Coworker / family email",
  "calendar.invite.roleViewer": "View only",
  "calendar.invite.roleEditor": "Can edit",
  "calendar.invite.send": "Send invite",
  "calendar.invite.messagePlaceholder": "Message (optional, shown in the invite email)",
  "calendar.members.heading": "Current members",
  "calendar.members.roleEditorShort": "Can edit",
  "calendar.members.roleViewerShort": "View only",
  "calendar.members.remove": "Remove",
  "calendar.members.removeConfirm": "Remove this member?",
  "calendar.members.removeOk": "Remove",
  "calendar.invitations.pendingHeading": "Pending invitations",
  "calendar.invitations.expiresAt": "Expires {at}",
  "calendar.invitations.revoke": "Revoke",
  "calendar.invitations.revokeConfirm": "Revoke this invitation?",
  "calendar.invitations.revokeOk": "Revoke",
  "calendar.share.heading": "🔗 Subscribe links",
  "calendar.share.count": "· {count}",
  "calendar.share.intro": "Once generated, paste the link into Google / Apple / Outlook calendar's \"Add subscribed calendar\".",
  "calendar.share.downloadIcs": "Download an .ics snapshot of this calendar",
  "calendar.share.labelPlaceholder": "Label (e.g. for family)",
  "calendar.share.generate": "Generate subscribe link",
  "calendar.share.empty": "No subscribe links yet",
  "calendar.share.unnamed": "Unnamed",
  "calendar.share.copyIcs": "Copy ICS",
  "calendar.share.copyEmbed": "Copy embed code",
  "calendar.share.revoke": "Revoke",
  "calendar.share.revokeConfirm": "Revoke this subscribe link? Already-subscribed clients will stop working.",
  "calendar.share.revokeOk": "Revoke",
  "calendar.import.heading": "📥 Import from another platform",
  "calendar.import.subCount": "· {count} subscriptions",
  "calendar.import.intro": "Four ways: upload an .ics file, paste ICS text, one-shot fetch from URL, or add a subscription (server syncs on a schedule).",
  "calendar.import.tabFile": "📁 File",
  "calendar.import.tabUrl": "🔗 URL (one-shot)",
  "calendar.import.tabSub": "🔁 Auto-sync subscription",
  "calendar.import.tabPaste": "📝 Paste text",
  "calendar.import.fileSubmit": "Upload and import",
  "calendar.import.fileHint": "Get an .ics file from Google Calendar Settings → Export, or Apple Calendar → File → Export.",
  "calendar.import.urlPlaceholder": "https://… or webcal://…",
  "calendar.import.urlSubmit": "Import now",
  "calendar.import.urlHint": "One-shot pull from a remote URL — no further auto-sync. Good for public holidays or class schedules.",
  "calendar.import.subUrlPlaceholder": "Remote ICS URL (https:// or webcal://)",
  "calendar.import.subSubmit": "Add subscription",
  "calendar.import.subLabelPlaceholder": "Label (e.g. work calendar / team schedule)",
  "calendar.import.refresh.hourly": "Every hour",
  "calendar.import.refresh.6h": "Every 6 hours",
  "calendar.import.refresh.12h": "Every 12 hours",
  "calendar.import.refresh.daily": "Every day",
  "calendar.import.refresh.weekly": "Every week",
  "calendar.import.subHint": "The server polls on a schedule and merges events incrementally (same UID = update, new UID = add). Deleting the subscription leaves imported events in place.",
  "calendar.import.subStatus.ok": "✓ Last synced {at} · {count} events",
  "calendar.import.subStatus.error": "✗ {at} failed: {err}",
  "calendar.import.subStatus.never": "Not synced yet",
  "calendar.import.subStatus.every": "· every {min} min",
  "calendar.import.subRefresh": "Sync now",
  "calendar.import.subDelete.confirm": "Delete this subscription? Imported events stay, but auto-sync stops.",
  "calendar.import.subDelete.ok": "Delete",
  "calendar.import.pastePlaceholder": "BEGIN:VCALENDAR\nVERSION:2.0\n…",
  "calendar.import.pasteSubmit": "Import text",
  "calendar.import.pasteHint": "If you can only get the raw text (e.g. an admin sent you some ICS), paste it here to import.",
  "calendar.events.heading": "Events",
  "calendar.events.showPast": "Show past events",
  "calendar.events.newButton": "New event",
  "calendar.events.titleLabel": "Title",
  "calendar.events.startLabel": "Start time",
  "calendar.events.endLabel": "End time",
  "calendar.events.locationLabel": "Location (optional)",
  "calendar.events.descriptionLabel": "Description (optional)",
  "calendar.events.add": "Add",
  "calendar.events.empty": "No events yet",
  "calendar.events.emptyFiltered": "No events in this range",
  "calendar.events.deleteConfirm": "Delete this event?",
  "calendar.events.deleteOk": "Delete",
  "calendar.events.delete": "Delete",

  // error
  "error.title": "Something went wrong",
  "error.notFoundTitle": "Page not found",
  "error.notFoundMessage": "What you're looking for doesn't exist or has been removed.",
  "error.internal": "Internal server error",
  "error.backHome": "Back to home",
};

const zhCN: Record<string, string> = {
  "common.save": "保存",
  "common.cancel": "取消",
  "common.delete": "删除",
  "common.confirm": "确认",
  "common.back": "返回",
  "common.continue": "继续",
  "common.required": "必填",

  "nav.calendar": "日历",
  "nav.search": "搜索",
  "nav.settings": "设置",
  "nav.admin": "管理后台",
  "nav.signOut": "退出登录",
  "nav.signIn": "登录",
  "nav.register": "注册",
  "footer.tagline": "自托管的日历共享平台",
  "footer.openSource": "开源项目",

  "login.title": "登录",
  "login.subtitle.withQr": "用密码 / Passkey 登录，或用手机 APP 扫码授权",
  "login.subtitle.noQr": "用密码或 Passkey 登录",
  "login.tabPassword": "密码登录",
  "login.tabQr": "扫码登录",
  "login.passkeyButton": "使用 Passkey 登录",
  "login.passkeyWaiting": "等待 Passkey…",
  "login.email": "邮箱",
  "login.password": "密码",
  "login.forgotPassword": "忘记密码？",
  "login.submit": "登录",
  "login.rememberMe": "保持登录（30 天）",
  "login.rememberMeHint": "· 不勾选则关闭浏览器即退出",
  "login.noAccount": "还没账号？",
  "login.qrLoading": "正在生成二维码…",
  "login.qrInstructions": "打开 <strong>ByWave Calendar</strong> 手机 APP，<br>点「设置 → 扫码登录网页版」，扫上面二维码。",
  "login.qrWaiting": "等待手机扫码授权…",
  "login.qrApproved": "✓ 已批准 —— 正在跳转…",
  "login.qrExpired": "二维码已过期",
  "login.qrDenied": "已拒绝授权",
  "login.qrError": "二维码生成失败 —— 请刷新页面重试",
  "login.qrFallback": "手机 APP 需要先用密码 / Passkey 登录一次 · 之后扫码即可",
  "login.qrRefresh": "重新生成二维码",
  "login.qrAdminDisabled": "管理员已停用网页扫码登录，请用密码登录",

  "settings.languageTitle": "语言",
  "settings.languageDesc": "选择网页 UI 语言。仅当前账号生效，覆盖网站默认语言。",
  "settings.languageFollowSite": "跟随网站默认",
  "settings.languageSaveSuccess": "语言已更新",

  "admin.siteLanguageTitle": "网站语言",
  "admin.siteLanguageDesc": "未登录访客 + 没设置过自己语言的用户看到的默认语言。",
  "admin.siteLanguageSaveSuccess": "网站语言已更新",

  "register.title": "创建账号",
  "register.subtitle": "免费使用，无需信用卡",
  "register.verifyNotice": "📨 提交后会向你的邮箱发送 6 位验证码，输入验证码后账号才会激活。",
  "register.emailLabel": "邮箱",
  "register.displayNameLabel": "昵称（可选）",
  "register.passwordLabel": "密码",
  "register.passwordHint": "至少 8 个字符，建议混合字母数字",
  "register.submit": "创建账号",
  "register.haveAccount": "已有账号？",
  "register.signIn": "登录",

  "resetPassword.title": "设置新密码",
  "resetPassword.subtitle": "请设置新的账号密码（至少 8 位）。完成后所有已登录设备会被强制下线。",
  "resetPassword.newPasswordLabel": "新密码",
  "resetPassword.confirmLabel": "再输一次",
  "resetPassword.submit": "设置新密码",
  "resetPassword.linkExpired": "链接已过期？",
  "resetPassword.requestAgain": "重新申请",

  "calendar.breadcrumb.myCalendars": "我的日历",
  "calendar.timezone": "时区 {tz}",
  "calendar.deleteCalendar.confirm": "确定删除整个日历？此操作不可恢复。",
  "calendar.deleteCalendar.title": "删除日历",
  "calendar.deleteCalendar.ok": "删除日历",
  "calendar.deleteCalendar.button": "删除日历",
  "calendar.expand": "展开 ▾",
  "calendar.invite.heading": "👥 邀请协作",
  "calendar.invite.memberCount": "· {count} 位成员",
  "calendar.invite.intro": "通过邮箱邀请他人加入这本日历。对方接受后会出现在他们的日历列表里。",
  "calendar.invite.emailPlaceholder": "同事 / 家人的邮箱",
  "calendar.invite.roleViewer": "只读查看",
  "calendar.invite.roleEditor": "可编辑",
  "calendar.invite.send": "发送邀请",
  "calendar.invite.messagePlaceholder": "留言（可选，会显示在邀请邮件里）",
  "calendar.members.heading": "当前成员",
  "calendar.members.roleEditorShort": "可编辑",
  "calendar.members.roleViewerShort": "只读",
  "calendar.members.remove": "移除",
  "calendar.members.removeConfirm": "确定移除该成员？",
  "calendar.members.removeOk": "移除",
  "calendar.invitations.pendingHeading": "待接受的邀请",
  "calendar.invitations.expiresAt": "到期 {at}",
  "calendar.invitations.revoke": "撤销",
  "calendar.invitations.revokeConfirm": "撤销这条邀请？",
  "calendar.invitations.revokeOk": "撤销",
  "calendar.share.heading": "🔗 订阅链接",
  "calendar.share.count": "· {count} 条",
  "calendar.share.intro": "生成后把链接粘贴到 Google / Apple / Outlook 日历的「添加订阅日历」即可。",
  "calendar.share.downloadIcs": "下载这本日历的 .ics 快照",
  "calendar.share.labelPlaceholder": "备注（如：给家人）",
  "calendar.share.generate": "生成订阅链接",
  "calendar.share.empty": "还没有订阅链接",
  "calendar.share.unnamed": "未命名",
  "calendar.share.copyIcs": "复制 ICS",
  "calendar.share.copyEmbed": "复制嵌入代码",
  "calendar.share.revoke": "撤销",
  "calendar.share.revokeConfirm": "确定撤销该订阅链接？已订阅的客户端会失效。",
  "calendar.share.revokeOk": "撤销",
  "calendar.import.heading": "📥 从其他平台导入",
  "calendar.import.subCount": "· {count} 个订阅",
  "calendar.import.intro": "四种方式：上传 .ics 文件、粘贴 ICS 文本、一次性从 URL 拉取、添加订阅（服务器按周期自动同步）。",
  "calendar.import.tabFile": "📁 文件",
  "calendar.import.tabUrl": "🔗 URL 一次性",
  "calendar.import.tabSub": "🔁 订阅自动同步",
  "calendar.import.tabPaste": "📝 粘贴文本",
  "calendar.import.fileSubmit": "上传并导入",
  "calendar.import.fileHint": "从 Google Calendar 设置 → 导出，或 Apple 日历 → 文件 → 导出，得到 .ics 文件。",
  "calendar.import.urlPlaceholder": "https://… 或 webcal://…",
  "calendar.import.urlSubmit": "立即导入",
  "calendar.import.urlHint": "一次性从远程 URL 拉取并导入，之后不再自动同步。适合公开节假日 / 课表的快照。",
  "calendar.import.subUrlPlaceholder": "远程 ICS URL（https:// 或 webcal://）",
  "calendar.import.subSubmit": "添加订阅",
  "calendar.import.subLabelPlaceholder": "备注（例如：公司日历 / 团队课表）",
  "calendar.import.refresh.hourly": "每小时同步",
  "calendar.import.refresh.6h": "每 6 小时同步",
  "calendar.import.refresh.12h": "每 12 小时同步",
  "calendar.import.refresh.daily": "每天同步",
  "calendar.import.refresh.weekly": "每周同步",
  "calendar.import.subHint": "服务器按周期拉取并增量更新事件（同 UID 即更新，新 UID 即新增）。删除订阅不会删除已导入的事件。",
  "calendar.import.subStatus.ok": "✓ 上次同步 {at} · {count} 个事件",
  "calendar.import.subStatus.error": "✗ {at} 失败：{err}",
  "calendar.import.subStatus.never": "尚未同步",
  "calendar.import.subStatus.every": "· 每 {min} 分钟",
  "calendar.import.subRefresh": "立即同步",
  "calendar.import.subDelete.confirm": "删除这个订阅？已导入的事件会保留，但不再自动同步。",
  "calendar.import.subDelete.ok": "删除",
  "calendar.import.pastePlaceholder": "BEGIN:VCALENDAR\nVERSION:2.0\n…",
  "calendar.import.pasteSubmit": "导入文本",
  "calendar.import.pasteHint": "如果你只能复制内容（比如管理员给的一段 ICS 文本），粘到这里就能导入。",
  "calendar.events.heading": "事件",
  "calendar.events.showPast": "显示过去事件",
  "calendar.events.newButton": "新建事件",
  "calendar.events.titleLabel": "标题",
  "calendar.events.startLabel": "开始时间",
  "calendar.events.endLabel": "结束时间",
  "calendar.events.locationLabel": "地点（可选）",
  "calendar.events.descriptionLabel": "描述（可选）",
  "calendar.events.add": "添加",
  "calendar.events.empty": "还没有事件",
  "calendar.events.emptyFiltered": "该时间段内没有事件",
  "calendar.events.deleteConfirm": "删除该事件？",
  "calendar.events.deleteOk": "删除",
  "calendar.events.delete": "删除",

  "error.title": "出错了",
  "error.notFoundTitle": "页面未找到",
  "error.notFoundMessage": "你访问的内容不存在或已被移除。",
  "error.internal": "服务器内部错误",
  "error.backHome": "回到首页",
};

const DICTIONARIES: Record<LocaleCode, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

/** Translate a single key under a given locale, with a graceful
 *  fallback chain. Optional `vars` substitutes `{name}` placeholders. */
export function translate(locale: LocaleCode, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES.en;
  let value = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (vars) {
    for (const [name, v] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(v));
    }
  }
  return value;
}

/** Cookie name for explicit user override. Lifetime: 1 year. Cleared
 *  when user selects 「跟随网站默认」 in the picker. */
export const LOCALE_COOKIE = "bwc_locale";
export const LOCALE_COOKIE_TTL_S = 365 * 24 * 60 * 60;

/** Parse the most-preferred supported locale from an Accept-Language
 *  header. Returns null when nothing matches — caller falls back. */
function pickFromAcceptLanguage(header: string | undefined): LocaleCode | null {
  if (!header) return null;
  // Accept-Language: "zh-CN,zh;q=0.9,en;q=0.8" → ranked list.
  const entries = header.split(",").map((s) => {
    const [tag, qPart] = s.trim().split(";");
    const q = qPart?.trim().startsWith("q=") ? parseFloat(qPart.trim().slice(2)) : 1;
    return { tag: tag?.toLowerCase() ?? "", q: isNaN(q) ? 0 : q };
  }).sort((a, b) => b.q - a.q);
  for (const e of entries) {
    if (!e.tag) continue;
    // Exact match (zh-cn → zh-CN)
    for (const l of LOCALES) {
      if (e.tag === l.code.toLowerCase()) return l.code;
    }
    // Language-only prefix (zh → zh-CN)
    const primary = e.tag.split("-")[0];
    for (const l of LOCALES) {
      if (l.code.toLowerCase().startsWith(primary + "-") || l.code.toLowerCase() === primary) {
        return l.code;
      }
    }
  }
  return null;
}

/** Resolve the effective locale for a request. Pass `siteDefault` and
 *  `userLocale` from the closest call site so this stays a pure
 *  function (testable, no DB I/O). */
export function resolveLocale(opts: {
  cookieValue?: string;
  userLocale?: string | null;
  siteDefault?: string;
  acceptLanguage?: string;
}): LocaleCode {
  // 1) explicit cookie
  if (isValidLocale(opts.cookieValue)) return opts.cookieValue;
  // 2) user preference
  if (isValidLocale(opts.userLocale)) return opts.userLocale;
  // 3) site default — "auto" means fall through to browser detection
  if (opts.siteDefault && opts.siteDefault !== "auto" && isValidLocale(opts.siteDefault)) {
    return opts.siteDefault;
  }
  // 4) Accept-Language
  const fromHeader = pickFromAcceptLanguage(opts.acceptLanguage);
  if (fromHeader) return fromHeader;
  // 5) hard fallback
  return "zh-CN";
}

/**
 * Convenience for route handlers / hooks: pulls cookie + Accept-Language
 * from the request, callers pass userLocale + siteDefault.
 */
export function resolveLocaleFromRequest(
  req: FastifyRequest,
  userLocale: string | null | undefined,
  siteDefault: string | undefined,
): LocaleCode {
  return resolveLocale({
    cookieValue: req.cookies[LOCALE_COOKIE],
    userLocale,
    siteDefault,
    acceptLanguage: req.headers["accept-language"] as string | undefined,
  });
}

/** Make a `t(key, vars?)` closure bound to a locale. Stashed on
 *  req.locals / view locals so EJS templates can call `t("login.email")`. */
export function makeT(locale: LocaleCode): (key: string, vars?: Record<string, string | number>) => string {
  return (key, vars) => translate(locale, key, vars);
}
