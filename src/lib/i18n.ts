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

  // common verbs (shared across surfaces)
  "common.copy": "Copy",

  // /app/settings — account tab
  "settings.account.profileTitle": "Profile",
  "settings.account.emailLabel": "Email",
  "settings.account.displayNameLabel": "Display name",
  "settings.account.createdAtLabel": "Joined",
  "settings.account.loginHistoryLink": "Login history",
  "settings.account.adminLink": "Admin console",
  "settings.account.deleteTitle": "⚠️ Delete account",
  "settings.account.deleteDesc": "Permanently delete your account — all calendars, events, subscriptions, passkeys, API tokens, and login history <strong>disappear immediately</strong> from the database and cannot be recovered. Invitation records for events you created will also be removed for other attendees.",
  "settings.account.deleteSummary": "I understand the risks — continue",
  "settings.account.deleteConfirmMessage": "Final check: this permanently deletes your account and can't be undone. Continue?",
  "settings.account.deleteConfirmOk": "Delete permanently",
  "settings.account.deleteConfirmTitle": "Delete account",
  "settings.account.deletePasswordLabel": "Current password",
  "settings.account.deleteConfirmFieldLabel": "Type \"delete my account\" to confirm",
  "settings.account.deleteConfirmFieldPlaceholder": "delete my account",
  "settings.account.deleteFinalButton": "Permanently delete my account",

  // /app/settings — security tab
  "settings.security.passwordTitle": "Change password",
  "settings.security.passwordDesc": "All sessions on every device will be signed out after this — you'll need to sign back in.",
  "settings.security.currentPasswordLabel": "Current password",
  "settings.security.newPasswordLabel": "New password",
  "settings.security.updatePassword": "Update password",
  "settings.security.passkeyDesc": "Sign in with Touch ID, Face ID, or a hardware key — safer and faster than password + MFA.",
  "settings.security.passkeyAdd": "Add passkey",
  "settings.security.passkeyEmpty": "No passkeys yet",
  "settings.security.passkeyAddedAt": "Added {date}",
  "settings.security.passkeyLastUsed": "Last used {date}",
  "settings.security.passkeyAddPrompt": "Name this passkey (e.g. Mac TouchID / iPhone)",
  "settings.security.passkeyAddSuccess": "Passkey added",
  "settings.security.passkeyAddFailed": "Couldn't add passkey: {error}",
  "settings.security.passkeyDelete": "Delete",
  "settings.security.passkeyDeleteConfirm": "Delete this passkey?",
  "settings.security.passkeyDeleteConfirmOk": "Delete",
  "settings.security.passkeyDeleted": "Deleted",
  "settings.security.passkeyDeleteFailed": "Couldn't delete",
  "settings.security.mfaTitle": "Two-factor (TOTP)",
  "settings.security.mfaEnabledNote": "✓ Two-factor is on — you'll be asked for the 6-digit code from your authenticator on sign-in.",
  "settings.security.mfaRegenSummary": "Regenerate backup codes",
  "settings.security.mfaRegenConfirm": "Generating new backup codes invalidates the old ones. Continue?",
  "settings.security.mfaRegenConfirmOk": "Regenerate",
  "settings.security.mfaRegenButton": "Generate new backup codes",
  "settings.security.mfaDisableSummary": "Turn off two-factor",
  "settings.security.mfaCodePlaceholder": "Enter current 6-digit code",
  "settings.security.mfaDisableButton": "Disable MFA",
  "settings.security.mfaDisabledNote": "Not enabled — once on, sign-in will require your password plus the 6-digit code from an authenticator (unless you use a passkey).",
  "settings.security.mfaSetupButton": "Set up TOTP",

  // /app/settings — devices tab (CalDAV connect + paired apps + app passwords)
  "settings.devices.caldavTitle": "CalDAV sync",
  "settings.devices.caldavDesc": "Connect your ByWave calendar to iPhone, Mac, Outlook, or Thunderbird — two-way sync for events, invites, and RSVPs.",
  "settings.devices.caldavServerLabel": "Server URL",
  "settings.devices.caldavUserLabel": "Username",
  "settings.devices.caldavPasswordLabel": "Password",
  "settings.devices.caldavCopy": "Copy",
  "settings.devices.caldavCopied": "Copied",
  "settings.devices.caldavPasswordHint": "We recommend <a href=\"#app-passwords\" class=\"text-brand-700 hover:underline\">generating an app password below</a>. Your account password also works (not recommended — required to use an app password once MFA is on).",
  "settings.devices.caldavIphoneSummary": "iPhone / iPad setup",
  "settings.devices.caldavIphoneStep1": "Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account",
  "settings.devices.caldavIphoneStep2": "Server: paste the \"Server URL\" from above",
  "settings.devices.caldavIphoneStep3": "Username: your email. Password: an app password.",
  "settings.devices.caldavIphoneStep4": "Description: anything (e.g. \"ByWave\"). Tap Next to save.",
  "settings.devices.caldavIphoneStep5": "Open the \"ByWave\" group in the Calendar app to see all your calendars. New events and invites sync in real time.",
  "settings.devices.caldavMacSummary": "macOS Calendar.app setup",
  "settings.devices.caldavMacStep1": "Calendar → Settings → Accounts → click + in the bottom-left → choose \"Other CalDAV Account\"",
  "settings.devices.caldavMacStep2": "Account Type: Manual. Username: your email. Password: app password. Server: the \"Server URL\" above.",
  "settings.devices.caldavMacStep3": "Sign in → pick the calendars to sync → Done.",
  "settings.devices.caldavOtherSummary": "Thunderbird / DAVx⁵ / Outlook",
  "settings.devices.caldavThunderbird": "<strong>Thunderbird</strong>: Calendar → New Calendar → On the Network → CalDAV → paste the server URL.",
  "settings.devices.caldavAndroid": "<strong>Android (DAVx⁵)</strong>: Add account → Login with URL and username → server URL + email + app password.",
  "settings.devices.caldavOutlook": "<strong>Outlook</strong>: no native CalDAV support — use the <code>Outlook CalDav Synchronizer</code> add-in or subscribe to an exported .ics feed.",
  "settings.devices.caldavTip": "💡 Invites are two-way over CalDAV: add a coworker's email as an ATTENDEE on your phone and they'll get a ByWave invitation email. Once they accept or decline, their reply shows up the next time your phone syncs.",
  "settings.devices.heading": "My devices",
  "settings.devices.desc": "Devices syncing your calendar via the iOS, Android, or desktop apps. Web browsers don't appear here — manage those under \"Sign out other sessions\".",
  "settings.devices.pairNew": "Pair new device",
  "settings.devices.disabledBadge": "Disabled",
  "settings.devices.adminDisabled": "The admin has turned off app sync.",
  "settings.devices.adminDisabledAdminHint": "Go to <a href=\"/admin/api#apps\" class=\"text-brand-700 hover:underline font-medium\">Admin → API</a> to turn it back on.",
  "settings.devices.adminDisabledUserHint": "Ask the admin to enable it.",
  "settings.devices.loading": "Loading…",
  "settings.devices.modalTitle": "Pair a new device",
  "settings.devices.modalClose": "Close",
  "settings.devices.modalIntro": "In the iOS or Android app, tap \"Scan to sign in\" and point the camera at the code below:",
  "settings.devices.modalGenerating": "Generating…",
  "settings.devices.modalManualSummary": "Or enter it manually (if the camera isn't available)",
  "settings.devices.modalServerLabel": "Server URL",
  "settings.devices.modalCodeLabel": "Pairing code",
  "settings.devices.modalExpires": "Valid for 5 minutes",
  "settings.devices.expiresIn": "About {mins} minutes left — if it expires, just click \"Pair new device\" again.",
  "settings.devices.empty": "No apps paired yet. Click \"Pair new device\" at the top right to add one.",
  "settings.devices.kindDesktop": "Desktop",
  "settings.devices.kindOther": "Other",
  "settings.devices.lastActive": "Last active {ago}",
  "settings.devices.revoke": "Unpair",
  "settings.devices.loadFailed": "Couldn't load — try refreshing.",
  "settings.devices.revokeConfirm": "Unpair this device? The app will stop syncing right away.",
  "settings.devices.revokeConfirmOk": "Unpair",
  "settings.devices.revokeSuccess": "Unpaired",
  "settings.devices.revokeFailed": "Couldn't unpair",
  "settings.devices.pairInitFailed": "Couldn't generate",
  "settings.devices.agoNever": "never",
  "settings.devices.agoJustNow": "just now",
  "settings.devices.agoMinutes": "{n} min ago",
  "settings.devices.agoHours": "{n} hr ago",
  "settings.devices.agoDays": "{n} d ago",
  "settings.devices.appPasswordsTitle": "CalDAV app passwords",
  "settings.devices.appPasswordsOptional": "Optional",
  "settings.devices.appPasswordsDesc": "Create a separate password for each phone or desktop calendar client so you don't hand out your account password. With MFA on, an app password is recommended for CalDAV.",
  "settings.devices.newAppPasswordHeading": "Generated \"{label}\" — shown only this once",
  "settings.devices.newAppPasswordDefaultLabel": "New app password",
  "settings.devices.copy": "Copy",
  "settings.devices.newAppPasswordHint": "Paste this into your CalDAV client's password field; use your email as the username. Once you reload the page it's gone — save it now.",
  "settings.devices.appPasswordLabelPlaceholder": "Device label (e.g. iPhone Calendar / Mac Calendar.app)",
  "settings.devices.generateAppPassword": "Generate app password",
  "settings.devices.appPasswordsEmpty": "No app passwords yet — your account password still works for CalDAV.",
  "settings.devices.appPasswordPrefix": "Prefix",
  "settings.devices.appPasswordCreated": "Created {date}",
  "settings.devices.appPasswordLastUsed": "Last used {date}",
  "settings.devices.appPasswordNeverUsed": "never used",
  "settings.devices.appPasswordRevoke": "Revoke",
  "settings.devices.appPasswordRevokeConfirm": "Revoking immediately invalidates this app password — the client will need a new one.",
  "settings.devices.appPasswordRevokeConfirmOk": "Revoke",
  "settings.devices.copySuccess": "Copied to clipboard",
  "settings.devices.copyFallback": "Selected — press Cmd/Ctrl+C to copy",

  // /app/settings — notifications tab (Web Push)
  "settings.notifications.pushTitle": "Browser push notifications",
  "settings.notifications.pushDesc": "Let your browser show desktop notifications when an event reminder fires (works on phone lock screens too). No email needed, but you'll have to allow notifications for this site.",
  "settings.notifications.pushChecking": "Checking…",
  "settings.notifications.pushEnable": "🔔 Enable push",
  "settings.notifications.pushDisable": "Disable push",
  "settings.notifications.pushTest": "Send test notification",
  "settings.notifications.pushUnsupported": "Your browser doesn't support Web Push (try Chrome, Edge, or Safari 16+).",
  "settings.notifications.pushDenied": "Your browser blocked notification permission. To turn it back on, click the lock icon next to the URL and allow notifications.",
  "settings.notifications.pushOn": "✓ Enabled — reminders will also appear as browser notifications on this device.",
  "settings.notifications.pushOff": "Not enabled",
  "settings.notifications.pushEnableFailed": "Couldn't enable: {error}",

  // /app/settings — appearance tab
  "settings.appearance.languageScope": "Just for you",
  "settings.appearance.languageLabel": "Language",
  "settings.appearance.themeTitle": "Appearance",
  "settings.appearance.themeScope": "Just for you",
  "settings.appearance.themeDesc": "Pick a color and density just for you, overriding the site defaults. Leave blank to follow the admin's site settings.",
  "settings.appearance.themeResetSite": "Reset to site default",
  "settings.appearance.paletteLabel": "Color (site default: <span class=\"font-mono\">{palette}</span>)",
  "settings.appearance.paletteIndigo": "Indigo",
  "settings.appearance.paletteEmerald": "Emerald",
  "settings.appearance.paletteRose": "Rose",
  "settings.appearance.paletteSky": "Sky",
  "settings.appearance.paletteAmber": "Amber",
  "settings.appearance.paletteViolet": "Violet",
  "settings.appearance.paletteSlate": "Slate",
  "settings.appearance.paletteNoneHint": "None = follow site settings",
  "settings.appearance.densityLabel": "Density (site default: <span class=\"font-mono\">{density}</span>)",
  "settings.appearance.densityComfortable": "Comfortable",
  "settings.appearance.densityComfortableHint": "Default spacing",
  "settings.appearance.densityCompact": "Compact",
  "settings.appearance.densityCompactHint": "Fit more on screen",
  "settings.appearance.saveTheme": "Save appearance",

  // /admin/site
  "adminSite.heading": "Site settings",
  "adminSite.siteNameLabel": "Site name",
  "adminSite.siteNameHint": "Shown in the browser title bar, nav, and emails.",
  "adminSite.registrationModeLabel": "Registration mode",
  "adminSite.registrationPublic": "Open (anyone can sign up)",
  "adminSite.registrationInvite": "Invite only (admin sends an invite link)",
  "adminSite.registrationClosed": "Closed (admin accounts only)",
  "adminSite.icpNumberLabel": "ICP filing number (fill in for mainland China deployments; otherwise leave blank)",
  "adminSite.icpNumberPlaceholder": "e.g. 沪ICP备2021023412号-2",
  "adminSite.icpNumberHint": "Hidden in the footer when empty.",
  "adminSite.icpUrlLabel": "ICP URL",
  "adminSite.languageWarning": "⚠ Individual users can override the site default via Settings → Language.",
  "adminSite.defaultLocaleLabel": "Default language",

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

  "common.copy": "复制",

  "settings.account.profileTitle": "资料",
  "settings.account.emailLabel": "邮箱",
  "settings.account.displayNameLabel": "昵称",
  "settings.account.createdAtLabel": "注册时间",
  "settings.account.loginHistoryLink": "登录历史",
  "settings.account.adminLink": "管理后台",
  "settings.account.deleteTitle": "⚠️ 删除账号",
  "settings.account.deleteDesc": "永久删除你的账号 —— 所有日历、事件、订阅、Passkey、API token、登录历史<strong>立即</strong>从数据库消失，无法恢复。其他人参加过你建的活动的邀请记录也会一起删除。",
  "settings.account.deleteSummary": "我了解风险，继续删除",
  "settings.account.deleteConfirmMessage": "最终确认：账号永久删除，不可恢复。继续？",
  "settings.account.deleteConfirmOk": "永久删除",
  "settings.account.deleteConfirmTitle": "删除账号",
  "settings.account.deletePasswordLabel": "当前密码",
  "settings.account.deleteConfirmFieldLabel": "输入「删除我的账号」以确认",
  "settings.account.deleteConfirmFieldPlaceholder": "删除我的账号",
  "settings.account.deleteFinalButton": "永久删除我的账号",

  "settings.security.passwordTitle": "修改密码",
  "settings.security.passwordDesc": "修改后所有设备的登录会话都会失效，需要重新登录",
  "settings.security.currentPasswordLabel": "当前密码",
  "settings.security.newPasswordLabel": "新密码",
  "settings.security.updatePassword": "更新密码",
  "settings.security.passkeyDesc": "用指纹 / Face ID / 硬件密钥免密码登录，比密码 + MFA 更安全更快",
  "settings.security.passkeyAdd": "添加 Passkey",
  "settings.security.passkeyEmpty": "还没有 Passkey",
  "settings.security.passkeyAddedAt": "添加于 {date}",
  "settings.security.passkeyLastUsed": "最近使用 {date}",
  "settings.security.passkeyAddPrompt": "给这把 Passkey 起个名字（比如 Mac TouchID / iPhone）",
  "settings.security.passkeyAddSuccess": "Passkey 添加成功",
  "settings.security.passkeyAddFailed": "添加失败：{error}",
  "settings.security.passkeyDelete": "删除",
  "settings.security.passkeyDeleteConfirm": "确定删除这把 Passkey？",
  "settings.security.passkeyDeleteConfirmOk": "删除",
  "settings.security.passkeyDeleted": "已删除",
  "settings.security.passkeyDeleteFailed": "删除失败",
  "settings.security.mfaTitle": "二次验证 (TOTP)",
  "settings.security.mfaEnabledNote": "✓ 二次验证已启用 —— 登录时需要输入认证器中的 6 位验证码",
  "settings.security.mfaRegenSummary": "重新生成备用码",
  "settings.security.mfaRegenConfirm": "生成新备用码会让旧的失效，确定？",
  "settings.security.mfaRegenConfirmOk": "重新生成",
  "settings.security.mfaRegenButton": "生成新备用码",
  "settings.security.mfaDisableSummary": "关闭二次验证",
  "settings.security.mfaCodePlaceholder": "输入当前 6 位验证码",
  "settings.security.mfaDisableButton": "关闭 MFA",
  "settings.security.mfaDisabledNote": "没启用 —— 启用后登录需要密码 + 认证器 6 位码（除非用 Passkey）",
  "settings.security.mfaSetupButton": "启用 TOTP",

  "settings.devices.caldavTitle": "CalDAV 同步",
  "settings.devices.caldavDesc": "把 ByWave 日历直接接到 iPhone / Mac / Outlook / Thunderbird，双向同步事件 + 邀请 + RSVP。",
  "settings.devices.caldavServerLabel": "服务器地址",
  "settings.devices.caldavUserLabel": "用户名",
  "settings.devices.caldavPasswordLabel": "密码",
  "settings.devices.caldavCopy": "复制",
  "settings.devices.caldavCopied": "已复制",
  "settings.devices.caldavPasswordHint": "建议<a href=\"#app-passwords\" class=\"text-brand-700 hover:underline\">生成下方应用密码</a>，主账号密码也可（不推荐 — 开启 MFA 后必须用应用密码）",
  "settings.devices.caldavIphoneSummary": "iPhone / iPad 接入步骤",
  "settings.devices.caldavIphoneStep1": "设置 → 日历 → 帐户 → 添加帐户 → 其他 → 添加 CalDAV 帐户",
  "settings.devices.caldavIphoneStep2": "服务器：粘贴上方「服务器地址」",
  "settings.devices.caldavIphoneStep3": "用户名：邮箱；密码：应用专属密码",
  "settings.devices.caldavIphoneStep4": "描述：随意，例如 \"ByWave\"；下一步保存",
  "settings.devices.caldavIphoneStep5": "日历 App 打开「ByWave」分组即可看到所有日历；新建事件 + 邀请同事都会实时同步",
  "settings.devices.caldavMacSummary": "macOS Calendar.app 接入步骤",
  "settings.devices.caldavMacStep1": "日历 → 设置 → 帐户 → 左下角 + → 选择「其他 CalDAV 帐户」",
  "settings.devices.caldavMacStep2": "帐户类型：手动；用户名：邮箱；密码：应用密码；服务器地址：上方「服务器地址」",
  "settings.devices.caldavMacStep3": "登录 → 选取要同步的日历 → 完成",
  "settings.devices.caldavOtherSummary": "Thunderbird / DAVx⁵ / Outlook",
  "settings.devices.caldavThunderbird": "<strong>Thunderbird</strong>：日历 → 新建日历 → 网络上 → CalDAV → 粘贴服务器地址",
  "settings.devices.caldavAndroid": "<strong>Android (DAVx⁵)</strong>：添加帐户 → 用 URL 和用户名登录 → 服务器地址 + 邮箱 + 应用密码",
  "settings.devices.caldavOutlook": "<strong>Outlook</strong>：原生不支持 CalDAV，可用 <code>Outlook CalDav Synchronizer</code> 插件或导出 .ics 订阅",
  "settings.devices.caldavTip": "💡 邀请功能在 CalDAV 上是双向的：你在手机上把同事的邮箱加进 ATTENDEE，对方会收到 ByWave 的邀请邮件；对方点击 Accept/Decline 后，下次手机同步就能看到对方的回执。",
  "settings.devices.heading": "我的设备",
  "settings.devices.desc": "用 iOS / Android / 桌面原生 APP 同步日历的设备。Web 浏览器不在这里 —— 用「踢出登录」管理浏览器会话。",
  "settings.devices.pairNew": "绑定新设备",
  "settings.devices.disabledBadge": "已停用",
  "settings.devices.adminDisabled": "管理员已关闭 APP 同步功能。",
  "settings.devices.adminDisabledAdminHint": "前往 <a href=\"/admin/api#apps\" class=\"text-brand-700 hover:underline font-medium\">管理后台 → API</a> 重新启用。",
  "settings.devices.adminDisabledUserHint": "请联系管理员开启。",
  "settings.devices.loading": "加载中…",
  "settings.devices.modalTitle": "绑定新设备",
  "settings.devices.modalClose": "关闭",
  "settings.devices.modalIntro": "在 iOS / Android APP 上选「扫码登录」，对准下面这张码就行：",
  "settings.devices.modalGenerating": "生成中…",
  "settings.devices.modalManualSummary": "手动输入也行（如果手机没相机权限）",
  "settings.devices.modalServerLabel": "服务器地址",
  "settings.devices.modalCodeLabel": "配对码",
  "settings.devices.modalExpires": "5 分钟内有效",
  "settings.devices.expiresIn": "约 {mins} 分钟内有效，过期后重新点「绑定新设备」即可",
  "settings.devices.empty": "还没有绑定 APP。点右上「绑定新设备」加一个。",
  "settings.devices.kindDesktop": "桌面",
  "settings.devices.kindOther": "其他",
  "settings.devices.lastActive": "最近活动 {ago}",
  "settings.devices.revoke": "解绑",
  "settings.devices.loadFailed": "加载失败 —— 刷新一下",
  "settings.devices.revokeConfirm": "解绑这个设备？该 APP 会立即失去同步能力。",
  "settings.devices.revokeConfirmOk": "解绑",
  "settings.devices.revokeSuccess": "已解绑",
  "settings.devices.revokeFailed": "解绑失败",
  "settings.devices.pairInitFailed": "生成失败",
  "settings.devices.agoNever": "从未",
  "settings.devices.agoJustNow": "刚刚",
  "settings.devices.agoMinutes": "{n} 分钟前",
  "settings.devices.agoHours": "{n} 小时前",
  "settings.devices.agoDays": "{n} 天前",
  "settings.devices.appPasswordsTitle": "CalDAV 应用专属密码",
  "settings.devices.appPasswordsOptional": "可选",
  "settings.devices.appPasswordsDesc": "为手机 / 桌面日历客户端单独生成密码，避免在第三方 App 里填主账号密码。开启 MFA 后建议使用应用密码连接 CalDAV。",
  "settings.devices.newAppPasswordHeading": "已生成「{label}」—— 只显示这一次",
  "settings.devices.newAppPasswordDefaultLabel": "新应用密码",
  "settings.devices.copy": "复制",
  "settings.devices.newAppPasswordHint": "把这串密码粘贴到 CalDAV 客户端的密码字段；用户名填邮箱即可。刷新页面后这段密码会消失，请立即保存。",
  "settings.devices.appPasswordLabelPlaceholder": "设备标签（如：iPhone 日历 / Mac Calendar.app）",
  "settings.devices.generateAppPassword": "生成新应用密码",
  "settings.devices.appPasswordsEmpty": "还没有应用密码 —— 主账号密码仍可用于 CalDAV 登录",
  "settings.devices.appPasswordPrefix": "前缀",
  "settings.devices.appPasswordCreated": "创建于 {date}",
  "settings.devices.appPasswordLastUsed": "最近使用 {date}",
  "settings.devices.appPasswordNeverUsed": "从未使用",
  "settings.devices.appPasswordRevoke": "撤销",
  "settings.devices.appPasswordRevokeConfirm": "撤销后这个应用密码立即失效，对应客户端需重新生成。",
  "settings.devices.appPasswordRevokeConfirmOk": "撤销",
  "settings.devices.copySuccess": "已复制到剪贴板",
  "settings.devices.copyFallback": "已选中，按 Cmd/Ctrl+C 复制",

  "settings.notifications.pushTitle": "浏览器推送通知",
  "settings.notifications.pushDesc": "允许浏览器在事件到达提醒时间时显示桌面通知（手机锁屏也能弹）。无需邮件，但需要浏览器开启过这个站点的通知权限。",
  "settings.notifications.pushChecking": "检测中…",
  "settings.notifications.pushEnable": "🔔 开启推送",
  "settings.notifications.pushDisable": "关闭推送",
  "settings.notifications.pushTest": "发送测试通知",
  "settings.notifications.pushUnsupported": "你的浏览器不支持 Web Push（试试 Chrome / Edge / Safari 16+）",
  "settings.notifications.pushDenied": "浏览器已拒绝通知权限。要重新开启，请在地址栏左侧的小锁图标里手动允许通知。",
  "settings.notifications.pushOn": "✓ 已开启 —— 提醒会同时发到这台设备的浏览器通知",
  "settings.notifications.pushOff": "还没开启",
  "settings.notifications.pushEnableFailed": "开启失败：{error}",

  "settings.appearance.languageScope": "仅你自己可见",
  "settings.appearance.languageLabel": "语言",
  "settings.appearance.themeTitle": "外观",
  "settings.appearance.themeScope": "仅你自己可见",
  "settings.appearance.themeDesc": "为你自己选个色系和密度，覆盖站点默认。不填则跟随管理员的站点设置。",
  "settings.appearance.themeResetSite": "恢复站点默认",
  "settings.appearance.paletteLabel": "主题色（站点默认：<span class=\"font-mono\">{palette}</span>）",
  "settings.appearance.paletteIndigo": "靛蓝",
  "settings.appearance.paletteEmerald": "翠绿",
  "settings.appearance.paletteRose": "玫瑰",
  "settings.appearance.paletteSky": "天蓝",
  "settings.appearance.paletteAmber": "琥珀",
  "settings.appearance.paletteViolet": "紫罗兰",
  "settings.appearance.paletteSlate": "石板灰",
  "settings.appearance.paletteNoneHint": "不选 = 跟随站点设置",
  "settings.appearance.densityLabel": "密度（站点默认：<span class=\"font-mono\">{density}</span>）",
  "settings.appearance.densityComfortable": "舒适",
  "settings.appearance.densityComfortableHint": "默认间距",
  "settings.appearance.densityCompact": "紧凑",
  "settings.appearance.densityCompactHint": "一屏多塞内容",
  "settings.appearance.saveTheme": "保存外观",

  "adminSite.heading": "站点设置",
  "adminSite.siteNameLabel": "站点名",
  "adminSite.siteNameHint": "显示在浏览器标题栏、导航栏和邮件里",
  "adminSite.registrationModeLabel": "注册策略",
  "adminSite.registrationPublic": "公开注册（任何人可注册）",
  "adminSite.registrationInvite": "仅邀请（需要管理员发邀请链接）",
  "adminSite.registrationClosed": "关闭（只剩管理员账号）",
  "adminSite.icpNumberLabel": "ICP 备案号（中国大陆部署填，否则留空）",
  "adminSite.icpNumberPlaceholder": "如：沪ICP备2021023412号-2",
  "adminSite.icpNumberHint": "留空时 footer 不显示",
  "adminSite.icpUrlLabel": "ICP 链接",
  "adminSite.languageWarning": "⚠ 单个用户在「设置 → 语言」可以覆盖网站默认语言。",
  "adminSite.defaultLocaleLabel": "默认语言",

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
