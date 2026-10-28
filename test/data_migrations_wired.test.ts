import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 程序里跑的数据迁移（src/lib/data_migrations.ts）有没有挂在会被执行的地方。
//
// 和 drizzle 的 journal 一个道理：写好了、没人调，部署成功、零报错、数据不对。
// 这一版要靠它把老的「删掉这一次」对到新的展开算法上 —— 没挂上的话，用户以前删掉的
// 那几次重复事件升级后会重新冒出来。
//
// 三条路都要跑到：
//   · scripts/migrate.ts（install.sh、后台「系统更新」、npm run db:migrate）
//   · src/lib/auto_migrate.ts（每次开机，git pull + pm2 reload 这种不走 install.sh 的升级）
//   · src/lib/backup.ts 的恢复（恢复回来的可能是升级前的老数据）
// 每条都要排在「表结构就绪」之后：记账列是 0057 加的，排在 SQL 迁移前面就读不到那一列。

// 先去掉注释再找：被注释掉的调用不能让门禁通过（以前出过「注释里的字样骗过门禁」）。
// 只认 // 行注释和 /* */ 块注释；字符串里恰好有 "//" 的地方（URL）这几个文件里没有调用要找。
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url).pathname, "utf8"));

describe("门禁自己：被注释掉的调用不算", () => {
  it("// 和 /* */ 里的 await runDataMigrations(db 都找不到", () => {
    expect(stripComments("  // await runDataMigrations(db, x)\n").indexOf("await runDataMigrations(db")).toBe(-1);
    expect(stripComments("/* await runDataMigrations(db) */").indexOf("await runDataMigrations(db")).toBe(-1);
    expect(stripComments("  await runDataMigrations(db); // ok").indexOf("await runDataMigrations(db")).toBeGreaterThan(-1);
  });
});

describe("数据迁移挂在三条路上", () => {
  it("scripts/migrate.ts：SQL 迁移之后调用 runDataMigrations", () => {
    const src = read("../scripts/migrate.ts");
    const migrate = src.indexOf("await migrate(db");
    const data = src.indexOf("await runDataMigrations(db");
    expect(migrate, "找不到 SQL 迁移那一步").toBeGreaterThan(-1);
    expect(data, "scripts/migrate.ts 没有调用 runDataMigrations —— 走 install.sh / 后台升级的站点不会迁移老数据").toBeGreaterThan(-1);
    expect(data, "数据迁移排在 SQL 迁移前面：记账列（0057）还不存在").toBeGreaterThan(migrate);
  });

  it("auto_migrate.ts：迁移器和兜底补丁之后、关连接之前调用 runDataMigrations", () => {
    const src = read("../src/lib/auto_migrate.ts");
    const fn = src.slice(src.indexOf("export async function runPendingMigrations"));
    const patches = fn.indexOf("for (const patch of DEFENSIVE_SCHEMA_PATCHES)");
    const data = fn.indexOf("await runDataMigrations(db)");
    const end = fn.indexOf("await client.end(");
    expect(patches).toBeGreaterThan(-1);
    expect(data, "开机流程没有调用 runDataMigrations —— git pull + pm2 reload 升级的站点不会迁移老数据").toBeGreaterThan(-1);
    expect(data, "要排在兜底补丁之后（补丁可能正是在补记账那一列）").toBeGreaterThan(patches);
    expect(data, "要排在关连接之前").toBeLessThan(end);
  });

  it("backup.ts：恢复成功之后调用 runDataMigrations", () => {
    const src = read("../src/lib/backup.ts");
    const fn = src.slice(src.indexOf("export async function importData"));
    const blocked = fn.indexOf("if (blocked) throw");
    const data = fn.indexOf("await runDataMigrations(db)");
    expect(data, "恢复一份升级前的备份之后，老的「删掉这一次」不会被迁移").toBeGreaterThan(-1);
    expect(data, "要排在「被拦下、什么都没恢复」那个出口之后").toBeGreaterThan(blocked);
  });
});
