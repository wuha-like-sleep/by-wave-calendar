import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createNotification } from "./notifications.js";
import { translate, isValidLocale, type LocaleCode } from "./i18n.js";
import { getSettings } from "./site_settings.js";

// 安全事件的站内镜像。
//
// 安全邮件（securityChangeMail / 新设备登录提醒）本来就关不掉 —— 它们是
// 账号被动手脚时所有者最后的知情渠道。但邮件会被漏看、会进垃圾箱，进了
// App 的人更不会为了确认一封邮件切出去。业界通行做法是账号内再留一份
// 安全动态（Google「近期安全活动」、GitHub 安全日志、Apple ID 通知）：
// 本函数就是那一份 —— 和安全邮件同源同点位触发（调用点都紧贴着发邮件
// 的地方），但落在站内收件箱，带未读角标，下次打开 App 就能看到。
//
// 纪律与邮件侧完全一致：
//   · 关不掉：不看任何偏好开关（安全类没有 opt-out，这是故意的）；
//   · 内容脱敏：Token 只出现名字和权限，永不出现明文（前缀都不给 ——
//     站内通知会长期留存，比一次性的邮件更不适合放可关联信息）；
//   · 旁路：写失败只记日志，绝不挡住发信和触发它的安全操作本身。

export type SecurityInboxKind =
  | "token_created" | "token_revoked"
  | "password_changed"
  | "mfa_enabled" | "mfa_disabled"
  | "passkey_added"
  | "new_login";

export type SecurityInboxContext = {
  /** Token 场景：用户给 Token 起的名字。 */
  tokenLabel?: string | null;
  /** Token 场景：权限原文（read / write）。 */
  tokenScope?: string | null;
  /** 新设备登录场景：设备描述（UA 摘要）。 */
  device?: string | null;
  /** 新设备登录场景：来源 IP。 */
  ip?: string | null;
};

async function localeFor(userId: string): Promise<LocaleCode> {
  const [user] = await db
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (isValidLocale(user?.locale)) return user.locale;
  const settings = await getSettings().catch(() => null);
  return isValidLocale(settings?.defaultLocale) ? settings.defaultLocale : "zh-CN";
}

function bodyFor(locale: LocaleCode, kind: SecurityInboxKind, ctx: SecurityInboxContext): string {
  switch (kind) {
    case "token_created":
    case "token_revoked": {
      const key = kind === "token_created" ? "notif.security.tokenCreated" : "notif.security.tokenRevoked";
      const scope = ctx.tokenScope === "read"
        ? translate(locale, "notif.security.scopeRead")
        : translate(locale, "notif.security.scopeWrite");
      return translate(locale, key, { label: ctx.tokenLabel || "API Token", scope });
    }
    case "password_changed": return translate(locale, "notif.security.passwordChanged");
    case "mfa_enabled": return translate(locale, "notif.security.mfaEnabled");
    case "mfa_disabled": return translate(locale, "notif.security.mfaDisabled");
    case "passkey_added": return translate(locale, "notif.security.passkeyAdded");
    case "new_login": return translate(locale, "notif.security.newLogin", { device: ctx.device || "—", ip: ctx.ip || "—" });
  }
}

export async function notifySecurityEvent(
  userId: string,
  kind: SecurityInboxKind,
  ctx: SecurityInboxContext = {},
): Promise<void> {
  try {
    const locale = await localeFor(userId);
    await createNotification({
      userId,
      type: "security_alert",
      title: translate(locale, "notif.security.title"),
      body: bodyFor(locale, kind, ctx),
      // 点开落在安全设置页：真出事时用户第一件事就是去那里核查。
      url: "/app/settings/security",
      // 安全事件值得推 —— 和邮件双通道，用户在哪个渠道先看到都行。
      push: { actionLabel: translate(locale, "notif.push.view") },
    });
  } catch (err) {
    console.warn("[security-inbox] mirror failed:", (err as Error).message);
  }
}
