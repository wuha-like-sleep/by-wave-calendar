import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// 写好的迁移到底会不会被执行。
//
// ── 为什么必须有这条 ──────────────────────────────────────────────────
//
// drizzle 的迁移器**不看目录**：它读 meta/_journal.json 的 entries，
// 一条一条去找对应的 .sql。所以一个迁移文件只要没进 journal，它就
// 永远不会被执行 —— 而目录里明明躺着，git 里明明提交了，谁看都以为它在跑。
//
// 这已经发生过：0052 和 0053 两个手写迁移都漏了 journal 条目。
// 0052 侥幸没出事，因为它只有 `ADD COLUMN IF NOT EXISTS`，而开机安全网
// （auto_migrate.ts）恰好用一模一样的默认值把列补出来了。
// 0053 就没这么走运：它带一句回填 UPDATE，安全网**故意不做**那一段，
// 于是存量数据一行都没被改对，而页面照着那一列显示。
//
// 失败形态是最坏的那种：部署成功、服务正常、页面打开、一个错都不报，
// 只是数据不对。

const DIR = path.resolve("drizzle/migrations");

function journalTags(): string[] {
  const j = JSON.parse(readFileSync(path.join(DIR, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  return j.entries.map((e) => e.tag);
}
function sqlTags(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
}

describe("每个迁移文件都要真的会被执行", () => {
  it("确实扫到了迁移（presence）", () => {
    // 少了这条，路径一写错就变成「0 个文件全部合规」，恒绿。
    expect(sqlTags().length, "一个迁移文件都没扫到 —— 这条用例什么也没验到").toBeGreaterThan(20);
    expect(journalTags().length, "journal 是空的").toBeGreaterThan(20);
  });

  it("**目录里的每个 .sql 都在 journal 里**", () => {
    const missing = sqlTags().filter((t) => !journalTags().includes(t));
    expect(
      missing,
      "这些迁移永远不会被执行：drizzle 只读 meta/_journal.json 里列出来的条目，" +
        "目录里有文件它也不看。部署会成功、服务会正常、一个错都不报，只是这些 SQL " +
        "从来没跑过。手写迁移时记得补 journal 条目（idx 递增、tag 是不带 .sql 的文件名）。",
    ).toEqual([]);
  });

  it("journal 里的每一条都有对应文件（反过来也不许缺）", () => {
    const orphan = journalTags().filter((t) => !sqlTags().includes(t));
    expect(orphan, "journal 指着不存在的迁移文件，启动时迁移器会直接抛").toEqual([]);
  });

  it("idx 连续且和文件名前缀对得上", () => {
    const j = JSON.parse(readFileSync(path.join(DIR, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    j.entries.forEach((e, i) => {
      expect(e.idx, `第 ${i} 条的 idx 不连续`).toBe(i);
      expect(e.tag.startsWith(String(e.idx).padStart(4, "0")), `${e.tag} 的编号和 idx(${e.idx}) 对不上`).toBe(true);
    });
  });
});
