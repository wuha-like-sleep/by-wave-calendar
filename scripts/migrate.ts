import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { runDataMigrations } from "../src/lib/data_migrations.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);

await migrate(db, { migrationsFolder: "./drizzle/migrations" });
console.log("migrations applied");

// SQL 迁移做不了的数据迁移（要展开重复规则、要换算时区），见 src/lib/data_migrations.ts。
// 跑过的会记账，第二次直接跳过；`--rerun-data-migrations` 无视记账全部重跑（每条都幂等）。
// 默认失败不算整个迁移失败：表结构已经升级好了，开机时（auto_migrate.ts）还会再试，
// 别为了它把一次升级卡死在半路。手动 --rerun 时失败就是失败。
const force = process.argv.includes("--rerun-data-migrations");
try {
  const { ran } = await runDataMigrations(db, { force });
  console.log(ran.length ? `data migrations applied: ${ran.join(", ")}` : "data migrations: nothing to do");
} catch (err) {
  console.error("data migrations FAILED（服务启动时会再试一次）:", err);
  if (force) {
    await client.end();
    process.exit(1);
  }
}
await client.end();
