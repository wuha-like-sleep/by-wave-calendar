// Auto-apply pending drizzle migrations at server boot.
//
// Why this exists: we shipped v1.3.10 (notifyEmail column on
// booking_links) and the production server did a normal
// `git pull && pm2 reload` without running `npm run migrate` first.
// Result: every hit on /app/booking-links 500'd with
// `column "notify_email" does not exist`. Easy mistake — install.sh
// runs migrate, but in-place rolling reloads don't go through
// install.sh. Auto-migrate-on-boot makes the failure class impossible
// to hit again.
//
// Safe properties:
//   - drizzle's migrator skips already-applied migrations (tracked in
//     a __drizzle_migrations table), so this is a no-op on normal
//     restarts — costs one SELECT per boot.
//   - Migrations are written with `ADD COLUMN IF NOT EXISTS` / similar
//     defenses, so even if the migrator gets confused about which were
//     applied (e.g. a snapshot was lost), the SQL itself is idempotent.
//   - On migration failure we log loudly and continue starting up. A
//     partially-broken endpoint (the one that needs the new column) is
//     better than zero availability.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { env } from "../env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runPendingMigrations(): Promise<void> {
  // Use a separate single-connection client for migrations — the main
  // pool shouldn't be pinned during the (typically <1s) migration run,
  // and after we close this client the pool keeps serving requests.
  const client = postgres(env.DATABASE_URL, {
    max: 1,
    prepare: false,
  });
  const db = drizzle(client);

  // Resolve the migrations folder relative to the project root rather
  // than __dirname — in dev (tsx) we're in src/lib/, in prod build
  // we're in dist/src/lib/. Walk up to the package root either way.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib/auto_migrate.ts → src/lib → src → projectRoot
  // dist/src/lib/auto_migrate.js → dist/src/lib → dist/src → dist → projectRoot
  const projectRoot = path.resolve(
    here,
    here.includes(`${path.sep}dist${path.sep}`) ? "../../.." : "../..",
  );
  const migrationsFolder = path.join(projectRoot, "drizzle", "migrations");

  // Try drizzle's normal migrator first. May fail if production's
  // __drizzle_migrations table is out of sync with our committed
  // _journal.json (which happens any time someone runs `db:push` or
  // a hand ALTER TABLE without going through migrate). Failures here
  // shouldn't block startup — defensiveSchemaPatches() below catches
  // the columns we care about regardless.
  try {
    const t0 = Date.now();
    await migrate(db, { migrationsFolder });
    const elapsed = Date.now() - t0;
    if (elapsed > 50) {
      console.log(`[auto-migrate] applied pending migrations in ${elapsed}ms`);
    }
  } catch (err) {
    console.error("[auto-migrate] drizzle migrator failed — falling through to defensive patches:", err);
  }

  // Defensive schema patches. Pure raw SQL with `IF NOT EXISTS` clauses
  // — fully idempotent, runs on every boot, costs ~5ms total. This is
  // the safety net for the class of bugs where drizzle's migrator state
  // disagrees with the actual DB schema (because of historical db:push
  // usage, manual hotfixes, lost _journal.json snapshots, etc).
  //
  // 逐条执行、逐条 catch：以前是一条 db.execute 里放一条 ALTER，加到第二条起
  // 就变成「前面一条炸了，后面几条全不跑」—— 而这里每一条修的都是不同的
  // 故障，互相之间没有依赖关系。一条失败不该连累其余的。
  let patched = 0;
  const t0 = Date.now();
  for (const patch of DEFENSIVE_SCHEMA_PATCHES) {
    try {
      await db.execute(sql.raw(patch.statement));
      patched++;
    } catch (err) {
      console.error(`[auto-migrate] defensive patch FAILED (${patch.why}):`, err);
    }
  }
  const elapsed = Date.now() - t0;
  if (elapsed > 50) {
    console.log(`[auto-migrate] ${patched}/${DEFENSIVE_SCHEMA_PATCHES.length} defensive schema patches applied in ${elapsed}ms`);
  }
  await client.end({ timeout: 5 });
}

/**
 * 开机安全网：运行时代码依赖、但存量库上可能缺的列。
 *
 * 什么时候该往这里加一条：**这一版的迁移新增了一个列，而代码读它**。
 * 判据不是「重要不重要」，是「缺了这一列会怎样」——
 *   · site_settings 的任何一列：drizzle 的 `db.select().from(siteSettings)`
 *     会把 schema.ts 里的列名一个不落地写进 SQL。缺一列不是读到 undefined，
 *     是这条查询直接报错，而每一个页面（包括登录页）都要读一次站点设置。
 *     也就是说：**缺 site_settings 的一列 = 整站白屏**。
 *   · users 的任何一列：同理，凡是 `select()`/`insert().returning()` 不带
 *     投影的地方都会炸，登录和注册都在其中。
 *
 * 什么时候该删：这一条在所有还活着的生产库上都落地之后。留着不算错（每条
 * 大约 0.5ms），但清单越长越没人看得懂哪条还在起作用。
 *
 * 导出成数据而不是写死在函数里，是为了让测试能把它拿去跑一遍 ——
 * 「安全网本身是坏的」这种事只有真跑一次才看得见。
 */
export const DEFENSIVE_SCHEMA_PATCHES: ReadonlyArray<{ why: string; statement: string }> = [
  {
    // v1.3.10。这一条就是这套安全网存在的原因，见文件顶上那段。
    why: "booking_links.notify_email（缺了 /app/booking-links 全 500）",
    statement: `ALTER TABLE booking_links ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT true`,
  },
  {
    // 0047。默认空串 = 不允许任何外部站点嵌入，和站点全局 frame-ancestors 'none'
    // 一致 —— 补出来的列必须和迁移里的默认值一字不差，否则「补上了」反而改了行为。
    why: "site_settings.embed_frame_ancestors（缺了每一个页面都 500）",
    statement: `ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS embed_frame_ancestors text NOT NULL DEFAULT ''`,
  },
  {
    // 0048。空串 = 不限制域名。默认值带一点限制性，升级当天注册就全死。
    why: "site_settings.signup_domain_allowlist（缺了每一个页面都 500）",
    statement: `ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS signup_domain_allowlist text NOT NULL DEFAULT ''`,
  },
  {
    // 0048。0 = 不限每日建号数。
    why: "site_settings.signup_daily_quota（缺了每一个页面都 500）",
    statement: `ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS signup_daily_quota integer NOT NULL DEFAULT 0`,
  },
  {
    // 0048。可空、不给存量行回填 —— 后台拿这一列做批量停用，猜错就是误杀真实用户。
    why: "users.signup_source（缺了登录和注册都 500）",
    statement: `ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source text`,
  },
  {
    // 0051。空串 = 「还没 bump 过」，和迁移里的默认值一字不差。
    // 补出来的值故意**不是** 0051 里那个发版字面量：这一条的职责是「别让整站
    // 白屏」，不是替迁移做决定。真补出空串来，代价只是这台机器上的强制重拉
    // 暂时不生效（客户端照常同步），而迁移器一旦恢复记账就会把值补上。
    why: "site_settings.caldav_sync_epoch（缺了每一个页面都 500）",
    statement: `ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS caldav_sync_epoch text NOT NULL DEFAULT ''`,
  },
];
