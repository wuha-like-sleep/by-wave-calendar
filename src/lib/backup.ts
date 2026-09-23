import { sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

// Tables in dependency order: parents before children. INSERT walks this list
// top-down so FKs always resolve. DELETE walks it in reverse so we never try
// to truncate a parent before its children.
//
// ⚠️ **不在这张表里 = 恢复备份时会被永久删掉。**
//
// 恢复是「整库替换」：先按这张表倒序清空，再按正序插回去。而清空里包含
// users，库里几乎每张表都以 ON DELETE CASCADE 挂在它下面 —— 也就是说
// **任何没写进这张表的用户数据，都会在清空那一步被连带删除，而插回去
// 那一步根本不会碰它**。站长看到的是一句「恢复完成」。
//
// 曾经漏掉的：预约链接和已收到的预约、三端 App 的登录凭据、SSO 绑定、
// 网页推送订阅。后果是恢复一次备份之后：客人约好的时间全没了、所有手机和
// 桌面端被登出且再也不在「我的设备」里、用第三方登录的人进不来。
//
// 真正「可以不要」的只有短时效的东西，它们跟着 cascade 一起消失是对的：
// sessions、password_resets、email_verifications、login_challenges、
// device_pairings（5 分钟一次性配对码）。**往下加表之前先问一句：
// 这张表丢了，用户会不会发现？会，就必须写进来。**
export const EXPORT_TABLES = [
  { name: "site_settings",        table: schema.siteSettings },
  // 两张站点级配置表，不挂在 users 下面 —— 丢了要重新注册所有第三方接入、
  // 重新配所有回调地址，而客户端那边的密钥已经发出去了，配不回原样。
  { name: "oauth_clients",        table: schema.oauthClients },
  { name: "webhooks",             table: schema.webhooks },
  { name: "users",                table: schema.users },
  // 下面三张都是 users 的子表，漏一张就等于恢复后用户被登出 / 登不进来。
  { name: "user_identities",      table: schema.userIdentities },
  { name: "devices",              table: schema.devices },
  { name: "push_subscriptions",   table: schema.pushSubscriptions },
  // 审计记录要跟着走：它是「谁在什么时候改了什么」的唯一底账。
  { name: "admin_audit_log",      table: schema.adminAuditLog },
  // 已经发出去、别人手上还拿着的邀请码。
  { name: "signup_invites",       table: schema.signupInvites },
  // 用户授权给第三方应用的访问令牌，丢了所有接入当场失效、要逐个重新授权。
  { name: "oauth_access_tokens",  table: schema.oauthAccessTokens },
  { name: "sso_providers",        table: schema.ssoProviders },
  { name: "login_alerts",         table: schema.loginAlerts },
  { name: "login_events",         table: schema.loginEvents },
  { name: "webauthn_credentials", table: schema.webauthnCredentials },
  { name: "app_passwords",        table: schema.appPasswords },
  { name: "api_tokens",           table: schema.apiTokens },
  { name: "calendars",            table: schema.calendars },
  // booking_links 挂在 users + calendars 上，排在两者之后；
  // bookings 还挂着 events，所以排在 events 之后。
  { name: "booking_links",        table: schema.bookingLinks },
  { name: "events",               table: schema.events },
  { name: "bookings",             table: schema.bookings },
  // 「这条提醒已经发过了」的台账。丢了会把已经发过的提醒又发一遍。
  { name: "reminders_sent",       table: schema.remindersSent },
  { name: "calendar_members",     table: schema.calendarMembers },
  { name: "calendar_invitations", table: schema.calendarInvitations },
  { name: "share_tokens",         table: schema.shareTokens },
  { name: "calendar_subscriptions", table: schema.calendarSubscriptions },
  { name: "event_invite_tokens",  table: schema.eventInviteTokens },
] as const;

/** 明确「不进备份」的表。跟着 users 的 cascade 一起消失是对的 ——
 *  它们要么几分钟就过期，要么恢复后会自然重新积累。
 *  **加进这个名单等于承诺「这张表丢了用户不会发现」，想清楚再加。**
 *  有一条断言盯着「凡是带 user_id 的表，要么在 EXPORT_TABLES 里，
 *  要么在这里」，见 test/backup_covers_user_data.test.ts。 */
export const BACKUP_EXCLUDED_TABLES = new Set([
  "sessions",
  "password_resets",
  "email_verifications",
  "login_challenges",
  "device_pairings",            // 5 分钟一次性配对码
  "oauth_authorization_codes",  // 10 分钟一次性授权码，换完令牌当场删
  "webhook_deliveries",         // 投递日志，会自己重新积累；而且它挂在 webhooks 下面
]);

export const BACKUP_VERSION = 1;

export type BackupBundle = {
  bundleVersion: number;
  exportedAt: string;
  productId: "by-wave-calendar";
  tables: Record<string, unknown[]>;
};

export async function exportData(): Promise<BackupBundle> {
  const tables: Record<string, unknown[]> = {};
  for (const t of EXPORT_TABLES) {
    // 软删的事件**也要导出**。以前这里把它们滤掉，而指向它们的邀请令牌
    // （event_invite_tokens.source_event_id，NOT NULL 外键）照样导出了 ——
    // 恢复时插到那一步外键报错，整个事务回滚，**这份备份根本恢复不了**。
    // 而且它们还在回收站里，用户随时可能撤销删除，本来就该跟着备份走。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tables[t.name] = await db.select().from(t.table as any);
  }
  return {
    bundleVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    productId: "by-wave-calendar",
    tables,
  };
}

export type ImportResult = {
  ok: boolean;
  perTable: { table: string; inserted: number; skipped: number; error?: string }[];
  totalInserted: number;
  /** 文件里**整张表都没有**的那些（不是「有但是空的」）。
   *
   *  用旧版本导出的备份恢复到新版本时会出现：那会儿还没把这几张表写进
   *  备份，而恢复的第一步是清空 —— 于是它们被清掉又没插回来。
   *  必须报给站长看，否则他得到的只有一句「恢复完成」。 */
  missingTables: string[];
};

// Restore mode is destructive: TRUNCATE every restorable table (in reverse
// dependency order), then INSERT the bundle's rows in dependency order.
// Wrapped in a single transaction so a failure mid-restore rolls back.
export async function importData(bundle: BackupBundle): Promise<ImportResult> {
  if (bundle.productId !== "by-wave-calendar") throw new Error("不是 ByWave Calendar 的备份文件");
  if (typeof bundle.bundleVersion !== "number" || bundle.bundleVersion > BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${bundle.bundleVersion}（本系统支持 ≤ ${BACKUP_VERSION}）`);
  }
  if (!bundle.tables || typeof bundle.tables !== "object") throw new Error("备份缺少 tables 字段");

  const perTable: ImportResult["perTable"] = [];
  const missingTables: string[] = [];
  let totalInserted = 0;
  await db.transaction(async (tx) => {
    // Wipe in reverse dependency order so children are gone before parents.
    for (let i = EXPORT_TABLES.length - 1; i >= 0; i--) {
      const t = EXPORT_TABLES[i]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await tx.delete(t.table as any);
    }
    // Re-insert in dependency order.
    for (const t of EXPORT_TABLES) {
      // 「文件里没有这张表」和「有但是空的」要分开：前者意味着这份备份是
      // 旧版本导出的，这张表会被清空且永远插不回来 —— 得告诉站长。
      if (!(t.name in bundle.tables)) missingTables.push(t.name);
      const rows = Array.isArray(bundle.tables[t.name]) ? bundle.tables[t.name]! : [];
      const log: { table: string; inserted: number; skipped: number; error?: string } = {
        table: t.name, inserted: 0, skipped: 0,
      };
      if (rows.length === 0) { perTable.push(log); continue; }
      try {
        // Bulk insert; revive Date columns from ISO strings (drizzle expects Date).
        const restored = rows.map((r) => reviveDates(r as Record<string, unknown>));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await tx.insert(t.table as any).values(restored as any);
        log.inserted = rows.length;
        totalInserted += rows.length;
      } catch (err) {
        log.skipped = rows.length;
        log.error = err instanceof Error ? err.message : String(err);
        // Rethrow so the transaction rolls back.
        perTable.push(log);
        throw err;
      }
      perTable.push(log);
    }
    // Reset all sequences? Not strictly needed: all PKs are uuid defaultRandom
    // or text. The one numeric PK (site_settings.id) is pinned to 1.
    void sql;
  });
  return { ok: true, perTable, totalInserted, missingTables };
}

function reviveDates(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) { out[k] = d; continue; }
    }
    out[k] = v;
  }
  return out;
}
