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
   *  备份，而恢复的第一步是清空 —— 于是它们被清掉又没插回来。 */
  missingTables: string[];
  /** missingTables 里**恢复前库里有数据**、站长确认过可以清空、这次真的被清空了的。
   *  空数组 = 这次恢复没有丢任何东西。 */
  emptiedTables: TableAtRisk[];
};

/** 恢复会把它清空、而这份备份又插不回来的表，以及它此刻在库里有几行。 */
export type TableAtRisk = { table: string; rows: number };

/**
 * 「这份备份恢复下去会丢数据，站长还没点头」。
 *
 * ── 为什么要先拦，而不是恢复完再提示 ──────────────────────────────────
 *
 * 恢复是整库替换：先清空 EXPORT_TABLES 里的每一张，再按文件插回去。
 * 文件里**整张表都没有**的那几张（1.7.3 之前导出的备份缺预约、预约链接、
 * App 设备登录、SSO 绑定、推送订阅、OAuth 接入……），清空之后就再也插不回来。
 * 以前的做法是恢复完了在页面上补一句「这些表现在是空的」—— 那时数据已经没了，
 * 这句话只能告诉站长他丢了什么，挽回不了任何东西。
 *
 * 现在：只要有一张「文件里没有、库里有数据」的表没被站长**逐张确认**过，
 * 就一行都不删，抛这个错，由调用方把清单摆给站长看。
 * 确认是按表名绑定的：确认过 A，库里后来又多出一张有数据的 B，照样拦。
 */
export class RestoreNeedsConfirmationError extends Error {
  readonly atRisk: TableAtRisk[];
  constructor(atRisk: TableAtRisk[]) {
    super(`恢复会清空 ${atRisk.length} 张备份里没有、库里有数据的表：${atRisk.map((r) => r.table).join("、")}`);
    this.name = "RestoreNeedsConfirmationError";
    this.atRisk = atRisk;
  }
}

export type ImportOptions = {
  /** 站长在拦截页上确认过「可以清空」的表名。不传 = 一张都没确认。 */
  confirmEmptying?: readonly string[];
};

/** 文件里「整张表都没有」：缺键，或者那个键不是数组（坏文件按缺失算，宁可多拦）。 */
function isAbsentFromBundle(bundle: BackupBundle, name: string): boolean {
  return !Array.isArray(bundle.tables[name]);
}

// Restore mode is destructive: TRUNCATE every restorable table (in reverse
// dependency order), then INSERT the bundle's rows in dependency order.
// Wrapped in a single transaction so a failure mid-restore rolls back.
//
// 文件里缺表、而库里那张表有数据时，**先拦下**（RestoreNeedsConfirmationError），
// 一行都不删；站长逐张确认过（opts.confirmEmptying）才照常恢复。
export async function importData(bundle: BackupBundle, opts: ImportOptions = {}): Promise<ImportResult> {
  if (bundle.productId !== "by-wave-calendar") throw new Error("不是 ByWave Calendar 的备份文件");
  if (typeof bundle.bundleVersion !== "number" || bundle.bundleVersion > BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${bundle.bundleVersion}（本系统支持 ≤ ${BACKUP_VERSION}）`);
  }
  if (!bundle.tables || typeof bundle.tables !== "object") throw new Error("备份缺少 tables 字段");

  const perTable: ImportResult["perTable"] = [];
  const missingTables: string[] = [];
  let emptiedTables: TableAtRisk[] = [];
  let totalInserted = 0;
  const confirmed = new Set(opts.confirmEmptying ?? []);
  const blocked = await db.transaction(async (tx) => {
    // **先数，再删。** 文件里没有、库里有数据的表，清空之后插不回来 ——
    // 在同一个事务里数，免得「数的时候是空的、删的时候已经有了」。
    const atRisk: TableAtRisk[] = [];
    for (const t of EXPORT_TABLES) {
      if (!isAbsentFromBundle(bundle, t.name)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(t.table as any);
      const n = Number(row?.n ?? 0);
      if (n > 0) atRisk.push({ table: t.name, rows: n });
    }
    // 有任何一张没被确认过：一行都不删，原样退出（事务里什么都没写）。
    if (atRisk.some((r) => !confirmed.has(r.table))) return atRisk;
    emptiedTables = atRisk;

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
      if (isAbsentFromBundle(bundle, t.name)) missingTables.push(t.name);
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
    return null;
  });
  // 在事务**外面**抛：事务里那一段只读不写、已经正常结束，这里抛出去的是
  // 原样的错误对象，调用方可以放心用 instanceof 认它。
  if (blocked) throw new RestoreNeedsConfirmationError(blocked);
  return { ok: true, perTable, totalInserted, missingTables, emptiedTables };
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
