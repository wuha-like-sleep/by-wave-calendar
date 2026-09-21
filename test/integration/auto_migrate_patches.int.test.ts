// 开机安全网（src/lib/auto_migrate.ts 的 DEFENSIVE_SCHEMA_PATCHES）本身有没有用。
//
// 这套东西存在的理由是「迁移器记账和真实 schema 对不上」。它一年也许只在一台机器上
// 起一次作用，所以它坏了没有任何人会发现 —— 直到那一台机器升级完整站白屏。
// 这里的做法是真的把列 DROP 掉，再把安全网跑一遍，看列有没有回来、回来的是不是
// 和迁移建出来的一模一样。
//
// 另外一条是「新加的列有没有被收进安全网」：判据不是人工记，是扫迁移文件。
import { beforeAll, describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { DEFENSIVE_SCHEMA_PATCHES } from "../../src/lib/auto_migrate.js";

// 单独起一个库：这套用例要 DROP 列，不能污染 harness 里那个共用实例。
const pg = new PGlite();

type ColShape = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const TABLES = ["site_settings", "users", "booking_links"];

/**
 * 从 idx 46 起新增的列必须被安全网收着。
 * 往前挪这个数 = 明确宣布「那之前的列在所有还活着的库上都落地了」，是个要动手的决定；
 * 不挪就永远不会因为「有人忘了」而静默变绿。
 */
const COVERED_FROM_MIGRATION = 46;

async function shapes(): Promise<Map<string, ColShape>> {
  const res = await pg.query<ColShape>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES],
  );
  return new Map(res.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
}

/** 安全网里每条语句碰的那个 <表>.<列>。 */
function patchedColumns(): string[] {
  return DEFENSIVE_SCHEMA_PATCHES.map((p) => {
    const m = /ALTER\s+TABLE\s+"?([a-z_]+)"?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?([a-z_]+)"?/i.exec(p.statement);
    if (!m) throw new Error(`安全网里这条语句不是可重入的 ADD COLUMN：${p.statement}`);
    return `${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`;
  });
}

async function runPatches(): Promise<void> {
  for (const p of DEFENSIVE_SCHEMA_PATCHES) await pg.exec(p.statement);
}

let pristine: Map<string, ColShape>;

beforeAll(async () => {
  const dir = "drizzle/migrations";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(`${dir}/${f}`, "utf8").split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  pristine = await shapes();
});

describe("开机安全网", () => {
  it("每条语句都写成可重入的 ADD COLUMN IF NOT EXISTS", () => {
    expect(patchedColumns().length).toBe(DEFENSIVE_SCHEMA_PATCHES.length);
  });

  it("每条语句指着一个真实存在的列 —— 拼错了的话它永远静静地什么都不做", () => {
    for (const key of patchedColumns()) {
      expect(pristine.has(key), `${key} 在迁移建出来的 schema 里不存在`).toBe(true);
    }
  });

  it("把这些列 DROP 掉之后，安全网能原样补回来（类型、默认值、可空性都一致）", async () => {
    const keys = patchedColumns();
    for (const key of keys) {
      const [t, c] = key.split(".");
      await pg.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    }
    const dropped = await shapes();
    for (const key of keys) {
      expect(dropped.has(key), `${key} 没被 DROP 掉，这条用例什么都没验到`).toBe(false);
    }

    await runPatches();

    const healed = await shapes();
    for (const key of keys) {
      expect(healed.get(key), `${key} 没被补回来`).toBeDefined();
      expect(healed.get(key), `${key} 补回来的形状和迁移建出来的不一样`).toEqual(pristine.get(key));
    }
  });

  it("补完再跑一遍不报错，也不改变任何一列的形状", async () => {
    const before = await shapes();
    await runPatches();
    expect(await shapes()).toEqual(before);
  });

  it(`idx ${COVERED_FROM_MIGRATION} 之后新增的列，一个不落地收在安全网里`, () => {
    const covered = new Set(patchedColumns());
    const pat = /ALTER\s+TABLE\s+"?(site_settings|users|booking_links)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?/gi;
    const missing: string[] = [];
    for (const f of readdirSync("drizzle/migrations").filter((x) => x.endsWith(".sql")).sort()) {
      const idx = Number(f.slice(0, 4));
      if (!Number.isFinite(idx) || idx < COVERED_FROM_MIGRATION) continue;
      const body = readFileSync(`drizzle/migrations/${f}`, "utf8");
      for (const m of body.matchAll(pat)) {
        const key = `${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`;
        if (!covered.has(key)) missing.push(`${f} → ${key}`);
      }
    }
    expect(missing, "这几列缺了安全网：迁移器记账一旦对不上，读这张表的每个请求都 500").toEqual([]);
  });
});
