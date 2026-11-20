// 自建地址包 provider（lib/geo_pack.ts）的口径，用与真实包相同 schema
// 的小型夹具包验证（临时目录现建，不把真包搬进仓库）：
//   一、同名竞争：POI 形查询里主站折叠行进前三、站台子部件行不霸榜；
//   二、单元折叠：同基础地址的单元变体只出一条、带 units；点名单元时
//       代表行就是该单元；无裸行时 label 去掉单元前缀；
//   三、缩略名（mcg）与乱序地名（melbourne university）能命中；
//   四、降级：包目录没配 / 不存在 → 空数组；provider=pack 时上层
//       fetchGeoSuggestions 回落 Photon。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fetchPackSuggestions,
  analyzeQuery,
  choosePackFiles,
  _resetGeoPackCacheForTests,
} from "../src/lib/geo_pack.js";
import { fetchGeoSuggestions } from "../src/lib/geo_suggest.js";

// --- 夹具构造：fold / expand / search_text 与管线 addr_common + s6 同口径 ---
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const ABBR_FULL: Record<string, string> = {
  RD: "ROAD", ST: "STREET", AVE: "AVENUE", PDE: "PARADE", PL: "PLACE",
};
function expand(folded: string): string {
  return folded.split(" ").map((t) => ABBR_FULL[t] ?? t).join(" ");
}
function searchText(r: FixtureRow): string {
  const dispF = fold(r.display);
  return [dispF, expand(dispF), fold(r.poi_name), (r.alias ?? "").toLowerCase(), `${fold(r.street_type)} ${fold(r.suburb)}`]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

interface FixtureRow {
  display: string; unit: string; number: string;
  street_name: string; street_type: string;
  suburb: string; state: string; postcode: string;
  poi_name: string; category: string; weight: number;
  lat: number | null; lon: number | null; sources: string;
  alias?: string;
}
const R = (r: Partial<FixtureRow> & { display: string }): FixtureRow => ({
  unit: "", number: "", street_name: "", street_type: "", suburb: "",
  state: "", postcode: "", poi_name: "", category: "", weight: 10,
  lat: null, lon: null, sources: "gnaf", ...r,
});

const ROWS: FixtureRow[] = [
  // Southern Cross 站区：G-NAF 命名行是 650 Collins St 的一排单元行
  ...["4", "5", "6", "7"].map((u) =>
    R({
      display: `${u}/650 Collins St, Docklands VIC 3008`, unit: u, number: "650",
      street_name: "Collins", street_type: "STREET", suburb: "Docklands",
      state: "VIC", postcode: "3008", poi_name: "Southern Cross Station",
      weight: 15.03, lat: -37.818, lon: 144.953,
    }),
  ),
  R({
    display: "Southern Cross Coach Terminal, Docklands VIC 3008",
    suburb: "Docklands", state: "VIC", postcode: "3008",
    poi_name: "Southern Cross Coach Terminal", category: "public_transport=station",
    weight: 28, sources: "osm", lat: -37.82, lon: 144.954,
  }),
  R({
    display: "Southern Cross, Docklands VIC 3008",
    suburb: "Docklands", state: "VIC", postcode: "3008",
    poi_name: "Southern Cross", category: "railway=stop",
    weight: 26, sources: "osm", lat: -37.818, lon: 144.953,
  }),
  ...["9", "11"].map((p) =>
    R({
      display: `Southern Cross ${p}, Docklands VIC 3008`,
      suburb: "Docklands", state: "VIC", postcode: "3008",
      poi_name: `Southern Cross ${p}`, category: "railway=stop",
      weight: 26, sources: "osm",
    }),
  ),
  // 大学同名竞争
  R({
    display: "University of Melbourne, Parkville VIC 3052",
    suburb: "Parkville", state: "VIC", postcode: "3052",
    poi_name: "University of Melbourne", category: "amenity=university",
    weight: 38, sources: "gnaf,osm", alias: "unimelb",
  }),
  R({
    display: "RMIT University, Melbourne VIC 3000",
    suburb: "Melbourne", state: "VIC", postcode: "3000",
    poi_name: "RMIT University", category: "amenity=university",
    weight: 30, sources: "osm",
  }),
  // MCG：缩略 token 在 alias 里（管线规则注入）
  R({
    display: "Melbourne Cricket Ground, Brunton Ave, Richmond VIC 3004",
    street_name: "Brunton", street_type: "AVENUE", suburb: "Richmond",
    state: "VIC", postcode: "3004", poi_name: "Melbourne Cricket Ground",
    weight: 40, sources: "gnaf,osm", alias: "mcg",
  }),
  // Kitchen Rd 与真实竞争街道
  R({
    display: "7 Kitchen Rd, Port Melbourne VIC 3207", number: "7",
    street_name: "Kitchen", street_type: "ROAD", suburb: "Port Melbourne",
    state: "VIC", postcode: "3207", weight: 19.1, sources: "gnaf,osm",
  }),
  R({
    display: "7 Kitchener Rd, Croydon VIC 3136", number: "7",
    street_name: "Kitchener", street_type: "ROAD", suburb: "Croydon",
    state: "VIC", postcode: "3136", weight: 14,
  }),
  // 单元组（无裸行）
  ...["12", "13"].map((u) =>
    R({
      display: `${u}/44-48 Marine Pde, Maroubra NSW 2035`, unit: u, number: "44-48",
      street_name: "Marine", street_type: "PARADE", suburb: "Maroubra",
      state: "NSW", postcode: "2035", weight: 12,
    }),
  ),
  // 单元组（有裸行）
  R({
    display: "200 Seven Hills Rd, Baulkham Hills NSW 2153", number: "200",
    street_name: "Seven Hills", street_type: "ROAD", suburb: "Baulkham Hills",
    state: "NSW", postcode: "2153", weight: 12,
  }),
  ...["1", "2"].map((u) =>
    R({
      display: `${u}/200 Seven Hills Rd, Baulkham Hills NSW 2153`, unit: u, number: "200",
      street_name: "Seven Hills", street_type: "ROAD", suburb: "Baulkham Hills",
      state: "NSW", postcode: "2153", weight: 12,
    }),
  ),
];

let packDir = "";
beforeAll(() => {
  packDir = mkdtempSync(path.join(tmpdir(), "bywave-geopack-fixture-"));
  const db = new DatabaseSync(path.join(packDir, "pack-au.sqlite"));
  db.exec(`CREATE TABLE addresses(
    cid INTEGER PRIMARY KEY, display TEXT, unit TEXT, number TEXT,
    street_name TEXT, street_type TEXT, suburb TEXT, state TEXT, postcode TEXT,
    poi_name TEXT, category TEXT, weight REAL, lat REAL, lon REAL, sources TEXT)`);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec('CREATE VIRTUAL TABLE addr_fts USING fts5(search_text, tokenize="unicode61 remove_diacritics 2")');
  db.exec("CREATE VIRTUAL TABLE addr_tri USING fts5(search_text, tokenize=trigram)");
  const ins = db.prepare(`INSERT INTO addresses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insFts = db.prepare("INSERT INTO addr_fts(rowid, search_text) VALUES (?,?)");
  const insTri = db.prepare("INSERT INTO addr_tri(rowid, search_text) VALUES (?,?)");
  ROWS.forEach((r, i) => {
    const cid = i + 1;
    ins.run(cid, r.display, r.unit, r.number, r.street_name, r.street_type, r.suburb,
      r.state, r.postcode, r.poi_name, r.category, r.weight, r.lat, r.lon, r.sources);
    const st = searchText(r);
    insFts.run(cid, st);
    insTri.run(cid, st);
  });
  const insMeta = db.prepare("INSERT INTO meta VALUES (?,?)");
  insMeta.run("pack_id", "au");
  insMeta.run("country", "AU");
  insMeta.run("region", "Australia");
  insMeta.run("schema", "1");
  db.close();
});
afterAll(() => {
  _resetGeoPackCacheForTests();
  rmSync(packDir, { recursive: true, force: true });
});

describe("analyzeQuery", () => {
  it("查询形状：POI 形与地址形", () => {
    expect(analyzeQuery("southern cross").poiShaped).toBe(true);
    expect(analyzeQuery("flinders street station").poiShaped).toBe(true);
    expect(analyzeQuery("mcg").poiShaped).toBe(true);
    expect(analyzeQuery("7 kitchen rd").poiShaped).toBe(false);
    expect(analyzeQuery("650 collins st").poiShaped).toBe(false);
  });

  it("显式单元号：斜杠形与关键字形", () => {
    expect(analyzeQuery("5/650 collins st").unit).toBe("5");
    expect(analyzeQuery("unit 6 650 collins").unit).toBe("6");
    expect(analyzeQuery("650 collins st").unit).toBeNull();
  });
});

describe("choosePackFiles", () => {
  it("有全国包只用全国包，否则用全部州包", () => {
    expect(choosePackFiles(["pack-au-vic.sqlite", "pack-au.sqlite", "pack-au-nsw.sqlite"])).toEqual(["pack-au.sqlite"]);
    expect(choosePackFiles(["pack-au-vic.sqlite", "pack-au-nsw.sqlite", "manifest.json"])).toEqual([
      "pack-au-nsw.sqlite",
      "pack-au-vic.sqlite",
    ]);
    expect(choosePackFiles(["manifest.json"])).toEqual([]);
  });
});

describe("fetchPackSuggestions", () => {
  it("同名竞争：主站单元行折叠成一条并进前三，站台行不霸榜", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "southern cross", limit: 5 });
    const folded = out.filter((s) => s.units);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.units).toEqual(["4", "5", "6", "7"]);
    expect(folded[0]!.label).toBe("Southern Cross Station, 650 Collins St, Docklands VIC 3008");
    expect(out.indexOf(folded[0]!)).toBeLessThan(3);
    // 站台子部件行（Southern Cross 9 / 11）排在主站折叠行之后
    const platformIdx = out.findIndex((s) => s.name === "Southern Cross 9");
    expect(platformIdx).toBeGreaterThan(out.indexOf(folded[0]!));
  });

  it("全名查询：主站折叠行第一", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "southern cross station", limit: 5 });
    expect(out[0]!.units).toEqual(["4", "5", "6", "7"]);
    expect(out[0]!.name).toBe("Southern Cross Station");
  });

  it("点名单元：代表行就是该单元", async () => {
    const slash = await fetchPackSuggestions({ packDir, query: "5/650 collins st", limit: 5 });
    const hit = slash.find((s) => s.units);
    expect(hit!.unit).toBe("5");
    expect(hit!.label).toContain("5/650 Collins St");

    const keyword = await fetchPackSuggestions({ packDir, query: "unit 6 650 collins", limit: 5 });
    const hit2 = keyword.find((s) => s.units);
    expect(hit2!.unit).toBe("6");
  });

  it("缩略名 mcg 命中 MCG", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "mcg", limit: 5 });
    expect(out[0]!.name).toBe("Melbourne Cricket Ground");
  });

  it("大学：全名精确与乱序都把 University of Melbourne 放第一", async () => {
    const exact = await fetchPackSuggestions({ packDir, query: "university of melbourne", limit: 5 });
    expect(exact[0]!.name).toBe("University of Melbourne");
    const reordered = await fetchPackSuggestions({ packDir, query: "melbourne university", limit: 5 });
    expect(reordered[0]!.name).toBe("University of Melbourne");
  });

  it("普通地址：7 Kitchen Rd 精确命中压过竞争街道", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "7 kitchen rd port melbourne", limit: 5 });
    expect(out[0]!.label).toBe("7 Kitchen Rd, Port Melbourne VIC 3207");
    expect(out[0]!.street).toBe("Kitchen Road 7");
    expect(out[0]!.country).toBe("Australia");
  });

  it("单元折叠（无裸行）：label 去单元前缀，units 全带", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "marine pde maroubra", limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("44-48 Marine Pde, Maroubra NSW 2035");
    expect(out[0]!.units).toEqual(["12", "13"]);
  });

  it("单元折叠（有裸行）：代表是裸行，units 全带", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "seven hills rd baulkham hills", limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("200 Seven Hills Rd, Baulkham Hills NSW 2153");
    expect(out[0]!.units).toEqual(["1", "2"]);
  });

  it("错字查询靠 trigram 救援仍能命中", async () => {
    const out = await fetchPackSuggestions({ packDir, query: "7 kitcen road port melbourne", limit: 5 });
    expect(out.map((s) => s.label)).toContain("7 Kitchen Rd, Port Melbourne VIC 3207");
  });

  it("降级：没配目录 / 目录不存在 → 空数组", async () => {
    expect(await fetchPackSuggestions({ packDir: undefined, query: "southern cross", limit: 5 })).toEqual([]);
    expect(await fetchPackSuggestions({ packDir: path.join(packDir, "nope"), query: "southern cross", limit: 5 })).toEqual([]);
  });
});

describe("fetchGeoSuggestions provider=pack 分发", () => {
  const photonStub = (async () =>
    ({
      ok: true,
      json: async () => ({
        features: [{ properties: { name: "Photon Place", city: "Melbourne" } }],
      }),
    }) as Response) as typeof fetch;

  it("包里有结果就用包，不打 Photon", async () => {
    let photonCalled = false;
    const spy = (async (...a: Parameters<typeof fetch>) => {
      photonCalled = true;
      return photonStub(...a);
    }) as typeof fetch;
    const out = await fetchGeoSuggestions({
      provider: "pack", baseUrl: "https://photon.example", packDir,
      query: "southern cross", limit: 5, timeoutMs: 1000, fetchImpl: spy,
    });
    expect(out.some((s) => s.name === "Southern Cross Station")).toBe(true);
    expect(photonCalled).toBe(false);
  });

  it("包不可用时回落 Photon", async () => {
    const out = await fetchGeoSuggestions({
      provider: "pack", baseUrl: "https://photon.example", packDir: "/nonexistent-packs",
      query: "anything", limit: 5, timeoutMs: 1000, fetchImpl: photonStub,
    });
    expect(out).toEqual([{ label: "Photon Place, Melbourne", name: "Photon Place", city: "Melbourne" }]);
  });
});
