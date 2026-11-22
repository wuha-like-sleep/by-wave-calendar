// 后台「地址包」清单与下载白名单（lib/geo_packs.ts）：
// 元数据取自 manifest、配套/共享文件归类正确、下载只认扫描白名单
// （目录穿越与未登记文件一律拒）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listGeoPacks, resolveGeoPackDownload } from "../src/lib/geo_packs.js";
import { attachEmbeddedAttribution } from "../src/lib/geo_pack_attribution.js";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bywave-geopacks-admin-"));
  writeFileSync(path.join(dir, "pack-au.sqlite"), "not-a-real-db");
  writeFileSync(path.join(dir, "manifest-au.json"), JSON.stringify({
    pack_id: "au", region: "Australia", pack_version: "2026.11.2",
    build_date: "2026-11-20T14:09:02Z", file: "pack-au.sqlite",
    bytes: 13, sha256: "abc123", rows_total: 16900927,
  }));
  writeFileSync(path.join(dir, "licence-manifest-au.json"), "{}");
  writeFileSync(path.join(dir, "ATTRIBUTION-au.txt"), "attribution");
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ pack_id: "au" }));
  mkdirSync(path.join(dir, "licences"));
  writeFileSync(path.join(dir, "licences", "odbl-1.0.txt"), "odbl");
  writeFileSync(path.join(dir, "stray.txt"), "not part of the pack layout");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("listGeoPacks", () => {
  it("未配置 → configured=false", async () => {
    expect((await listGeoPacks(undefined)).configured).toBe(false);
    expect((await listGeoPacks(null)).configured).toBe(false);
  });

  it("包与 manifest 元数据对上，配套与共享文件归类正确", async () => {
    const listing = await listGeoPacks(dir);
    expect(listing.configured).toBe(true);
    expect(listing.packs).toHaveLength(1);
    const pack = listing.packs[0]!;
    expect(pack.id).toBe("au");
    expect(pack.rows).toBe(16900927);
    expect(pack.sha256).toBe("abc123");
    expect(pack.buildDate).toBe("2026-11-20T14:09:02Z");
    expect(pack.packVersion).toBe("2026.11.2");
    expect(pack.region).toBe("Australia");
    expect(pack.companions.map((f) => f.name).sort()).toEqual([
      "ATTRIBUTION-au.txt",
      "licence-manifest-au.json",
      "manifest-au.json",
    ]);
    expect(listing.sharedFiles.map((f) => f.name).sort()).toEqual([
      "licences/odbl-1.0.txt",
      "manifest.json",
    ]);
  });
});

describe("attachEmbeddedAttribution（清单页从包内读许可/署名）", () => {
  let embDir = "";
  beforeAll(() => {
    embDir = mkdtempSync(path.join(tmpdir(), "bywave-geopacks-embedded-"));
    const mk = (file: string, meta: Record<string, string>) => {
      const db = new DatabaseSync(path.join(embDir, file));
      db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
      const ins = db.prepare("INSERT INTO meta VALUES (?,?)");
      for (const [k, v] of Object.entries(meta)) ins.run(k, v);
      db.close();
    };
    mk("pack-au-ot.sqlite", {
      pack_id: "au-ot",
      schema: "2",
      attribution: "Embedded attribution text",
      licence_manifest: JSON.stringify({
        pack_id: "au-ot",
        sources: [{ name: "GeoNames", licence: "CC BY 4.0" }],
      }),
      licences: JSON.stringify({ "cc-by-4.0.txt": "full text" }),
    });
    mk("pack-au-legacy.sqlite", { pack_id: "au-legacy", schema: "1" });
  });
  afterAll(() => rmSync(embDir, { recursive: true, force: true }));

  it("listGeoPacks 本身不读 sqlite（embedded 恒为 null），attach 后新包有内嵌、旧包仍 null", async () => {
    const listing = await listGeoPacks(embDir);
    expect(listing.packs.map((p) => p.embedded)).toEqual([null, null]);
    await attachEmbeddedAttribution(listing, embDir);
    const ot = listing.packs.find((p) => p.id === "au-ot")!;
    expect(ot.embedded?.attribution).toBe("Embedded attribution text");
    expect(ot.embedded?.licenceManifest?.sources).toEqual([
      expect.objectContaining({ name: "GeoNames", licence: "CC BY 4.0" }),
    ]);
    expect(ot.embedded?.licences).toEqual({ "cc-by-4.0.txt": "full text" });
    const legacy = listing.packs.find((p) => p.id === "au-legacy")!;
    expect(legacy.embedded).toBeNull();
  });
});

describe("resolveGeoPackDownload", () => {
  it("白名单内的文件可下载", async () => {
    expect((await resolveGeoPackDownload(dir, "pack-au.sqlite"))?.bytes).toBe(13);
    expect(await resolveGeoPackDownload(dir, "licences/odbl-1.0.txt")).not.toBeNull();
    expect(await resolveGeoPackDownload(dir, "ATTRIBUTION-au.txt")).not.toBeNull();
  });

  it("穿越与未登记文件一律拒", async () => {
    expect(await resolveGeoPackDownload(dir, "../secret")).toBeNull();
    expect(await resolveGeoPackDownload(dir, "licences/../../etc/passwd")).toBeNull();
    expect(await resolveGeoPackDownload(dir, "stray.txt")).toBeNull();
    expect(await resolveGeoPackDownload(dir, "pack-au-vic.sqlite")).toBeNull();
    expect(await resolveGeoPackDownload(undefined, "pack-au.sqlite")).toBeNull();
  });
});
