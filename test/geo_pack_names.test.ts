import { describe, expect, it } from "vitest";
import { makeT } from "../src/lib/i18n.js";
import {
  geoPackNameInfo,
  geoPackSortRank,
  parseGeoPackId,
} from "../src/lib/geo_pack_names.js";
import { buildGeoPackPageModel } from "../src/lib/geo_pack_page.js";
import { fetchGeoReleaseIndex, type GeoFetchImpl } from "../src/lib/geo_release.js";
import type { GeoPackInfo } from "../src/lib/geo_packs.js";
import type { GeoReleaseIndex } from "../src/lib/geo_release.js";

const zh = makeT("zh-CN");
const en = makeT("en");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("parseGeoPackId", () => {
  it("splits country and region", () => {
    expect(parseGeoPackId("au-nsw")).toEqual({ country: "au", region: "nsw" });
    expect(parseGeoPackId("au")).toEqual({ country: "au", region: null });
    expect(parseGeoPackId("AU-OT")).toEqual({ country: "au", region: "ot" });
  });
});

describe("geoPackNameInfo", () => {
  it("resolves AU region names from i18n in zh and en", () => {
    expect(geoPackNameInfo(zh, "au-nsw", "New South Wales, Australia").name).toBe("新南威尔士州");
    expect(geoPackNameInfo(en, "au-nsw", "New South Wales, Australia").name).toBe("New South Wales");
    expect(geoPackNameInfo(zh, "au-ot", null).name).toBe("其他领地");
    expect(geoPackNameInfo(zh, "au-nsw", null).countryName).toBe("澳大利亚");
  });

  it("names the national pack with the country template", () => {
    const info = geoPackNameInfo(zh, "au", null);
    expect(info.national).toBe(true);
    expect(info.name).toBe("澳大利亚（全国汇总）");
    expect(geoPackNameInfo(en, "au", null).name).toBe("Australia (nationwide)");
  });

  it("falls back to the manifest region, then to the code, for unknown ids", () => {
    expect(geoPackNameInfo(en, "au-xx", "Somewhere, Australia").name).toBe("Somewhere, Australia");
    expect(geoPackNameInfo(en, "au-xx", null).name).toBe("XX");
    expect(geoPackNameInfo(en, "zz-yy", null).countryName).toBe("ZZ");
  });
});

describe("geoPackSortRank", () => {
  it("orders national first, then AU regions in the fixed order, unknown last", () => {
    const ids = ["au-ot", "au-vic", "au", "au-nsw", "au-xx", "au-act"];
    const sorted = ids.sort((a, b) => {
      const ra = geoPackSortRank(parseGeoPackId(a));
      const rb = geoPackSortRank(parseGeoPackId(b));
      return ra[0] - rb[0] || ra[1].localeCompare(rb[1]);
    });
    expect(sorted).toEqual(["au", "au-nsw", "au-vic", "au-act", "au-ot", "au-xx"]);
  });
});

function pack(over: Partial<GeoPackInfo> = {}): GeoPackInfo {
  return {
    id: "au-nsw", file: "pack-au-nsw.sqlite", bytes: 1000, rows: 500,
    sha256: SHA_A, buildDate: "2026-11-22T01:00:00Z", packVersion: "2026.11.4",
    region: "New South Wales, Australia", companions: [], embedded: null,
    ...over,
  };
}

function indexWith(packs: GeoReleaseIndex["packs"]): GeoReleaseIndex {
  return { release: "geo-packs-au-v2", generatedAt: "2026-11-22T00:00:00Z", packs };
}

function indexPack(over: Partial<GeoReleaseIndex["packs"][number]> = {}): GeoReleaseIndex["packs"][number] {
  return {
    packId: "au-nsw", file: "pack-au-nsw.sqlite", bytes: 1000, sha256: SHA_A,
    rows: 500, region: "New South Wales, Australia", packVersion: "2026.11.4", parts: 0,
    ...over,
  };
}

describe("buildGeoPackPageModel", () => {
  it("marks a pack latest when the release sha matches the local manifest sha", () => {
    const m = buildGeoPackPageModel({ t: zh, packs: [pack()], releaseIndex: indexWith([indexPack()]), syncByFile: {} });
    expect(m.groups[0]!.rows[0]!.status).toBe("latest");
    expect(m.summary).toMatchObject({ installedCount: 1, checked: true, updateCount: 0, missingCount: 0 });
    expect(m.packNames["au-nsw"]).toBe("新南威尔士州");
  });

  it("marks a pack update when the release sha differs and exposes the release version", () => {
    const m = buildGeoPackPageModel({
      t: zh, packs: [pack()],
      releaseIndex: indexWith([indexPack({ sha256: SHA_B, packVersion: "2026.12.0" })]),
      syncByFile: {},
    });
    const row = m.groups[0]!.rows[0]!;
    expect(row.status).toBe("update");
    expect(row.releaseVersion).toBe("2026.12.0");
    expect(m.summary.updateCount).toBe(1);
  });

  it("falls back to byte comparison when the local manifest has no sha", () => {
    const m = buildGeoPackPageModel({
      t: zh, packs: [pack({ sha256: null, bytes: 900 })],
      releaseIndex: indexWith([indexPack({ bytes: 1000 })]),
      syncByFile: {},
    });
    expect(m.groups[0]!.rows[0]!.status).toBe("update");
  });

  it("never claims latest when the release index is unavailable", () => {
    const m = buildGeoPackPageModel({ t: zh, packs: [pack()], releaseIndex: null, syncByFile: {} });
    expect(m.groups[0]!.rows[0]!.status).toBe("installed");
    expect(m.summary.checked).toBe(false);
  });

  it("adds release-only packs as missing rows and aggregates the summary", () => {
    const vic = pack({ id: "au-vic", file: "pack-au-vic.sqlite", rows: 300, bytes: 800, buildDate: "2026-11-21T01:00:00Z" });
    const m = buildGeoPackPageModel({
      t: zh, packs: [pack(), vic],
      releaseIndex: indexWith([
        indexPack(),
        indexPack({ packId: "au-vic", file: "pack-au-vic.sqlite" }),
        indexPack({ packId: "au-qld", file: "pack-au-qld.sqlite", region: "Queensland, Australia" }),
      ]),
      syncByFile: {},
    });
    expect(m.summary).toMatchObject({ installedCount: 2, totalRows: 800, totalBytes: 1800, missingCount: 1 });
    expect(m.summary.versions).toEqual(["2026.11.4"]);
    expect(m.summary.latestBuildDate).toBe("2026-11-22T01:00:00Z");
    const qld = m.groups[0]!.rows.find((r) => r.id === "au-qld")!;
    expect(qld.status).toBe("missing");
    expect(qld.file).toBeNull();
    expect(qld.name).toBe("昆士兰州");
    // 组内排序：nsw 在 vic 前，qld（未安装）按地区序排在 vic 后
    expect(m.groups[0]!.rows.map((r) => r.id)).toEqual(["au-nsw", "au-vic", "au-qld"]);
  });
});

describe("fetchGeoReleaseIndex", () => {
  const manifest = {
    format: 1,
    release: "geo-packs-au-vTest",
    generated_at: "2026-11-22T00:00:00Z",
    packs: [{
      pack_id: "au-nsw", file: "pack-au-nsw.sqlite", bytes: 1000, sha256: SHA_A,
      rows_total: 500, region: "New South Wales, Australia", pack_version: "2026.11.4",
    }],
    shared: [],
  };
  const okFetch: GeoFetchImpl = async () =>
    new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });

  it("returns the pack index from a valid manifest", async () => {
    const idx = await fetchGeoReleaseIndex({ baseUrl: "https://example.invalid/rel", fetchImpl: okFetch });
    expect(idx?.release).toBe("geo-packs-au-vTest");
    expect(idx?.packs).toEqual([{
      packId: "au-nsw", file: "pack-au-nsw.sqlite", bytes: 1000, sha256: SHA_A,
      rows: 500, region: "New South Wales, Australia", packVersion: "2026.11.4", parts: 0,
    }]);
  });

  it("returns null on HTTP errors, network failures and invalid manifests", async () => {
    const http500: GeoFetchImpl = async () => new Response("nope", { status: 500 });
    await expect(fetchGeoReleaseIndex({ baseUrl: "https://example.invalid", fetchImpl: http500 })).resolves.toBeNull();
    const boom: GeoFetchImpl = async () => { throw new Error("dns"); };
    await expect(fetchGeoReleaseIndex({ baseUrl: "https://example.invalid", fetchImpl: boom })).resolves.toBeNull();
    const garbage: GeoFetchImpl = async () => new Response("not json", { status: 200 });
    await expect(fetchGeoReleaseIndex({ baseUrl: "https://example.invalid", fetchImpl: garbage })).resolves.toBeNull();
  });

  it("returns null instead of hanging when the source stalls past the timeout", async () => {
    const hanging: GeoFetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      fetchGeoReleaseIndex({ baseUrl: "https://example.invalid", fetchImpl: hanging, timeoutMs: 30 }),
    ).resolves.toBeNull();
  });
});
