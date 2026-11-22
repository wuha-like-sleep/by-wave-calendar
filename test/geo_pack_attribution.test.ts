// 包内嵌许可/署名读取（lib/geo_pack_attribution.ts）：
// 2026.11.4 起的包把 attribution / licence_manifest / licences 写在
// sqlite meta 里。读得到 → 解析成结构化 bundle；旧包没这三个键、
// 文件损坏、文件不存在 —— 一律 null，绝不抛错。
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseEmbeddedLicenceManifest,
  parseEmbeddedLicences,
  readEmbeddedPackAttribution,
} from "../src/lib/geo_pack_attribution.js";

const dir = mkdtempSync(path.join(tmpdir(), "bywave-geoattr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LICENCE_MANIFEST = {
  pack_id: "au-ot",
  derived_database_notice: "This pack is a derived database.",
  sources: [
    {
      name: "G-NAF",
      licence: "Open G-NAF EULA (CC BY 4.0-based)",
      data_version: "NOV 2026",
      attribution_text: "© Geoscape Australia",
      share_alike: false,
      restrictions: ["Must not be used to generate addresses for mail."],
      internal_use: true,
    },
    {
      name: "OpenAddresses",
      licence: "per-source (UNVERIFIED)",
      included: false,
      note: "Excluded: licences not yet verified.",
    },
    { name: "缺许可字段的条目会被丢弃" },
    "not-an-object",
  ],
};

function buildPack(file: string, meta: Record<string, string>): string {
  const full = path.join(dir, file);
  const db = new DatabaseSync(full);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  const ins = db.prepare("INSERT INTO meta VALUES (?,?)");
  for (const [k, v] of Object.entries(meta)) ins.run(k, v);
  db.close();
  return full;
}

const embeddedPack = buildPack("pack-au-ot.sqlite", {
  pack_id: "au-ot",
  country: "AU",
  schema: "2",
  attribution: "Address data attributions - test pack\n\n1. G-NAF - (c) Geoscape Australia.",
  licence_manifest: JSON.stringify(LICENCE_MANIFEST),
  licences: JSON.stringify({
    "odbl-1.0.txt": "Open Database License full text",
    "cc-by-4.0.txt": "CC BY 4.0 full text",
    "bad-entry.txt": 42,
  }),
});

const legacyPack = buildPack("pack-au-legacy.sqlite", {
  pack_id: "au-legacy",
  country: "AU",
  schema: "1",
});

const brokenManifestPack = buildPack("pack-au-broken.sqlite", {
  pack_id: "au-broken",
  attribution: "Attribution survives a broken licence_manifest.",
  licence_manifest: "{not json",
  licences: "[1,2,3]",
});

const corruptFile = path.join(dir, "pack-au-corrupt.sqlite");
writeFileSync(corruptFile, "this is not a sqlite file at all, just text");

describe("readEmbeddedPackAttribution", () => {
  it("内嵌三键齐全 → 解析出 bundle（来源条目防御性清洗）", async () => {
    const bundle = await readEmbeddedPackAttribution(embeddedPack);
    expect(bundle).not.toBeNull();
    expect(bundle!.attribution).toContain("G-NAF - (c) Geoscape Australia");
    const man = bundle!.licenceManifest;
    expect(man).not.toBeNull();
    expect(man!.packId).toBe("au-ot");
    expect(man!.derivedDatabaseNotice).toBe("This pack is a derived database.");
    // 缺 licence 的条目和非对象条目被丢弃，只剩两个合法来源
    expect(man!.sources).toHaveLength(2);
    expect(man!.sources[0]).toMatchObject({
      name: "G-NAF",
      licence: "Open G-NAF EULA (CC BY 4.0-based)",
      dataVersion: "NOV 2026",
      attributionText: "© Geoscape Australia",
      shareAlike: false,
      restrictions: ["Must not be used to generate addresses for mail."],
    });
    expect(man!.sources[1]).toMatchObject({ name: "OpenAddresses", included: false });
    // licences 里非字符串值的条目被丢弃
    expect(bundle!.licences).toEqual({
      "odbl-1.0.txt": "Open Database License full text",
      "cc-by-4.0.txt": "CC BY 4.0 full text",
    });
  });

  it("旧包（schema 1，无内嵌键）→ null", async () => {
    expect(await readEmbeddedPackAttribution(legacyPack)).toBeNull();
  });

  it("licence_manifest 是坏 JSON → 该字段 null，其余键照常", async () => {
    const bundle = await readEmbeddedPackAttribution(brokenManifestPack);
    expect(bundle).not.toBeNull();
    expect(bundle!.attribution).toContain("Attribution survives");
    expect(bundle!.licenceManifest).toBeNull();
    expect(bundle!.licences).toEqual({});
  });

  it("损坏文件 / 不存在的文件 → null，不抛错", async () => {
    expect(await readEmbeddedPackAttribution(corruptFile)).toBeNull();
    expect(await readEmbeddedPackAttribution(path.join(dir, "pack-nope.sqlite"))).toBeNull();
  });
});

describe("parseEmbeddedLicenceManifest / parseEmbeddedLicences", () => {
  it("形状不对一律降级", () => {
    expect(parseEmbeddedLicenceManifest("[]")).toBeNull();
    expect(parseEmbeddedLicenceManifest("{}")).toBeNull(); // 没有 sources 数组
    expect(parseEmbeddedLicenceManifest("not json")).toBeNull();
    expect(parseEmbeddedLicences("{}")).toEqual({});
    expect(parseEmbeddedLicences('"just a string"')).toEqual({});
  });
});
