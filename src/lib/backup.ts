import { sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

// Tables in dependency order: parents before children. INSERT walks this list
// top-down so FKs always resolve. DELETE walks it in reverse so we never try
// to truncate a parent before its children.
//
// Note: we intentionally skip the transient/security-relevant tables that
// shouldn't migrate between deployments (sessions, password_resets,
// email_verifications, login_challenges). They'll be empty post-restore and
// will repopulate from normal user activity.
const EXPORT_TABLES = [
  { name: "site_settings",        table: schema.siteSettings },
  { name: "users",                table: schema.users },
  { name: "sso_providers",        table: schema.ssoProviders },
  { name: "login_alerts",         table: schema.loginAlerts },
  { name: "login_events",         table: schema.loginEvents },
  { name: "webauthn_credentials", table: schema.webauthnCredentials },
  { name: "app_passwords",        table: schema.appPasswords },
  { name: "api_tokens",           table: schema.apiTokens },
  { name: "calendars",            table: schema.calendars },
  { name: "events",               table: schema.events },
  { name: "calendar_members",     table: schema.calendarMembers },
  { name: "calendar_invitations", table: schema.calendarInvitations },
  { name: "share_tokens",         table: schema.shareTokens },
  { name: "calendar_subscriptions", table: schema.calendarSubscriptions },
  { name: "event_invite_tokens",  table: schema.eventInviteTokens },
] as const;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await db.select().from(t.table as any);
    tables[t.name] = rows;
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
  return { ok: true, perTable, totalInserted };
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
