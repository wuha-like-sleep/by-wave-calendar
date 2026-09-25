// Centralized user-active gate. Admins disable accounts via /admin/users —
// every credential-accepting entry point must check this, otherwise the
// disabled user keeps slipping in via CalDAV / API tokens / SSO / Passkey.
//
// We had a hole here: only the web login form + session loader checked
// disabledAt. CalDAV basic-auth, bearer-token auth, SSO callback, and
// Passkey verify all ignored it.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export function userIsActive(user: { disabledAt: Date | null } | null | undefined): boolean {
  return !!user && user.disabledAt === null;
}

// How many usable (not disabled) admins exist right now. Caller uses this
// to refuse demote/disable/delete operations that would leave the system
// with zero admins — a footgun that requires manual DB intervention to
// recover from. Returns the COUNT, not a boolean, so callers can phrase
// the error message ("you are the last admin" vs "only N admins remain").
export async function countActiveAdmins(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(schema.users)
    .where(and(eq(schema.users.isAdmin, true), isNull(schema.users.disabledAt)));
  return row?.n ?? 0;
}

// Bulk-revoke every long-lived credential a user has so that disabling /
// kicking them is actually effective. Sessions still need a separate
// `delete from sessions where user_id = ?` because they're an opaque
// blob keyed by sid; we don't track them as revocable.
//
// **第三方授权（OAuth）也在这里。** 原来漏了它：用户察觉被盗、改完密码，
// 页面说「已更新，请重新登录」，会话清了、手机 App 也被踢了，三个信号都在
// 告诉他人已经赶走了 —— 而攻击者替他点过一次「同意」拿到的那张令牌，
// 还能继续读写他的日历，一直用到默认 30 天到期。
export async function revokeAllUserCredentials(userId: string): Promise<void> {
  const now = new Date();
  await db
    .update(schema.apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)));
  await db
    .update(schema.appPasswords)
    .set({ revokedAt: now })
    .where(and(eq(schema.appPasswords.userId, userId), isNull(schema.appPasswords.revokedAt)));
  await db
    .update(schema.oauthAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.oauthAccessTokens.userId, userId), isNull(schema.oauthAccessTokens.revokedAt)));
}

/**
 * 把一个人手上**所有**能进这个号的钥匙一次作废。
 *
 * ── 为什么收成一个函数 ────────────────────────────────────────────────
 *
 * 「踢人」有五条路：网页改密码、忘记密码重置、App 里改密码、后台停用、
 * 后台踢出登录。以前每条路各自列一张清单，于是每条都漏了点不一样的东西：
 *
 *   · 三条改密码的路都没吊销应用密码（CalDAV）和第三方授权 —— 用户以为
 *     改完密码就把盗号的人赶走了，其实对方还能继续同步他的日历；
 *   · 重置密码那条连 CalDAV 的认证缓存都没清；
 *   · 后台停用和踢出都没吊销手机 App —— 踢出之后手机照常用，
 *     停用再启用手机会自己复活，因为它手上那张刷新令牌一直有效。
 *
 * 清单只在这一处写。**往下加一种新的凭据时，加在这里，五条路一起生效。**
 *
 * @param opts.exceptDeviceId App 里改密码时保留当前这台，否则用户改完自己就被登出。
 */
export async function evictAllCredentials(
  userId: string,
  opts: { exceptDeviceId?: string } = {},
): Promise<{ devicesRevoked: number }> {
  // 动态 import：session.ts / devices.ts 都会反过来引这个文件，写成静态
  // import 就是循环依赖，而那种错误只在某个加载顺序下才炸。
  const { destroyAllUserSessions } = await import("./session.js");
  const { revokeAllUserDevices } = await import("./devices.js");
  const { invalidateCalDavAuthCache } = await import("./caldav_auth.js");

  // 浏览器会话
  await destroyAllUserSessions(userId);
  // 手机 / 桌面 App 的刷新令牌
  const devicesRevoked = await revokeAllUserDevices(userId, { exceptDeviceId: opts.exceptDeviceId });
  // API Token、应用密码（CalDAV）、第三方授权
  await revokeAllUserCredentials(userId);
  // CalDAV 鉴权有 60 秒缓存，不清的话外面那台 iPhone 还能再同步一分钟。
  invalidateCalDavAuthCache(userId);
  return { devicesRevoked };
}
