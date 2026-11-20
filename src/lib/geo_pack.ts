// 自建地址包（DGX 管线产出的 pack-*.sqlite）的服务端适配层。
//
// 包的形状（管线 PLAN §1-2，schema 1）：
//   addresses(cid, display, unit, number, street_name, street_type,
//             suburb, state, postcode, poi_name, category, weight,
//             lat, lon, sources)
//   addr_fts  —— FTS5 unicode61(remove_diacritics) over 折叠后的 search_text
//   addr_tri  —— FTS5 trigram over 同一份 search_text（错字救援）
//   meta      —— pack_id / country / region / schema / built_unix
// search_text 里已经含显示串折叠形 + 街道类型展开形 + POI 名 + 别名
// （名称变体与缩略 token，如 mcg / qvm），所以查询侧不需要再做展开。
//
// 检索口径与管线黄金门（s7d）保持一致，先宽窗口召回再统一打分：
//   一级：addr_fts 全 token 前缀 AND 匹配（LIMIT 5000，不用 bm25 预排——
//         它的长度偏置会把 POI 长文本行先挤出窗口）；
//   二级：查询 token 的 trigram 集合在 addr_tri 里 OR 匹配（bm25 取前
//         2000），与一级合并（错字时一级也会漏，不能只在一级为空时跑）；
//   打分：token 覆盖（精确 数字 6 / 词 3，前缀 1，全覆盖 +5）
//         + trigram 重叠率 ×8 + weight ×0.5。
// 在此之上是本站的排序层（见 rankCandidates / foldUnitGroups）：
//   - POI 形查询（不带门牌号的纯地名/机构名）给「名字对得上」的行加权，
//     并按 category 的显著度分层——解决同名竞争里主站被同站汽车站、
//     电车站台行挤掉的问题；规则只看 category 与名字 token 形状，
//     不写死任何具体地名。
//   - 单元行折叠：同一基础地址的单元变体在响应组装层折成一条，带
//     units 列表——解决带单元号的行变体把裸行压下去的问题。包数据
//     本身不动。
//
// 降级纪律与 Photon 适配层一致：包目录没配、包文件不存在、sqlite
// 打不开、查询出错——一律返回空数组，由上层回落 Photon，绝不抛错、
// 绝不让现有部署因为没包就报错。node:sqlite 是懒加载的：老 Node
// （需要实验开关的版本）加载失败同样走降级。

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { GeoSuggestion } from "./geo_suggest.js";

/** 包里一行地址（addresses 表的原始形状，NULL 已归一成空串/ null）。 */
export interface PackRow {
  cid: number;
  display: string;
  unit: string;
  number: string;
  street_name: string;
  street_type: string;
  suburb: string;
  state: string;
  postcode: string;
  poi_name: string;
  category: string;
  weight: number;
  lat: number | null;
  lon: number | null;
  sources: string;
}

// ---------------------------------------------------------------------------
// 查询折叠：与管线 addr_common.fold 同口径（NFKD、去变音、上转、
// 非字母数字转空格），最后转小写去对包里的小写 search_text。
// ---------------------------------------------------------------------------

export function foldQueryText(s: string): string {
  const stripped = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return stripped
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 黄金门口径的 token 化：长度 ≥2，或纯数字（一位门牌也要留）。 */
export function queryTokens(query: string): string[] {
  return foldQueryText(query)
    .split(" ")
    .filter((t) => t.length >= 2 || /^\d+$/.test(t));
}

function trigramsOf(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 查询形状分析：POI 形 vs 地址形；显式单元号。
// ---------------------------------------------------------------------------

/** 街道类型词（全称 + 常见缩写，折叠形）。只用来判断查询形状：
 *  「带门牌号」或「街道类型词 + 数字」→ 地址形；其余 → POI 形。
 *  「Flinders Street Station」里 Street 是街名的一部分，但它没有数字，
 *  仍判 POI 形——这正是地标查询想要的。 */
const STREET_TYPE_TOKENS = new Set([
  "road", "rd", "street", "st", "avenue", "ave", "drive", "dr", "court", "ct",
  "place", "pl", "lane", "la", "parade", "pde", "highway", "hwy", "crescent",
  "cres", "boulevard", "bvd", "terrace", "tce", "esplanade", "esp", "parkway",
  "pwy", "circuit", "cct", "close", "cl", "grove", "gr", "square", "sq",
  "track", "trk", "walk", "wlk", "way", "trail", "trl", "promenade", "prom",
  "quay", "qy", "rise", "retreat", "rtt", "gardens", "gdns", "heights", "hts",
]);

export interface QueryShape {
  tokens: string[];
  folded: string;
  /** 不带门牌号的纯地名/机构名查询（"southern cross"、"mcg"）。 */
  poiShaped: boolean;
  /** 查询里显式写出的单元号（"5/650 …"、"unit 5 …"），没有为 null。 */
  unit: string | null;
}

export function analyzeQuery(query: string): QueryShape {
  const tokens = queryTokens(query);
  const folded = tokens.join(" ");
  const hasDigit = tokens.some((t) => /^\d/.test(t));
  const firstIsNumber = tokens.length > 0 && /^\d/.test(tokens[0]!);
  const hasStreetType = tokens.some((t) => STREET_TYPE_TOKENS.has(t));
  const poiShaped = !(firstIsNumber || (hasDigit && hasStreetType));

  let unit: string | null = null;
  const slash = /(?:^|\s)(\d{1,5}[a-z]?)\s*\//i.exec(query);
  const keyword = /\b(?:unit|apt|apartment|suite|shop|flat)\s+(\d{1,5}[a-z]?)\b/i.exec(query);
  const m = slash ?? keyword;
  if (m?.[1]) unit = m[1].toUpperCase();
  return { tokens, folded, poiShaped, unit };
}

// ---------------------------------------------------------------------------
// 排序层一：名字匹配与 category 显著度（只对 POI 形查询全量生效）。
//
// nameTier（越小越优先）：
//   0 名字与查询折叠后完全相等（"university of melbourne"）
//   1 名字以查询为短语前缀、多的部分是词（"… Station"、"… Coach Terminal"），
//     或查询比名字更具体（名字是查询的前缀）
//   2 名字以查询为前缀但多的部分只有数字（站台/出口类子部件行，
//     如 "Southern Cross 9"）——它是这个地点的一部分，不是地点本身，
//     排在正名之后；或查询 token 全在名字里（乱序）
//   3 无名字关系
// 同 tier 内按 rankScore 比：黄金门分数 + 名字加权 + 显著度。
// 显著度只按 category 前缀查表，是「这类地点本身有多像用户要找的
// 那个地方」的通用先验，不针对任何具体地名。
// ---------------------------------------------------------------------------

const CATEGORY_PROMINENCE: ReadonlyArray<readonly [string, number]> = [
  ["railway=station", 6],
  ["amenity=hospital", 6],
  ["public_transport=station", 5],
  ["amenity=university", 5],
  ["place=city", 5],
  ["tourism=attraction", 4],
  ["amenity=school", 4],
  ["amenity=townhall", 4],
  ["shop=mall", 4],
  ["amenity=marketplace", 4],
  ["leisure=park", 3],
  ["place=town", 3],
  ["public_transport=stop_area", 2],
  ["railway=stop", 2],
  ["public_transport=platform", 1],
  ["public_transport=stop_position", 1],
];

export function categoryProminence(row: PackRow): number {
  for (const [prefix, score] of CATEGORY_PROMINENCE) {
    if (row.category.startsWith(prefix)) return score;
  }
  // G-NAF 命名建筑行没有 category，但 poi_name 本身就是显著信号。
  return row.poi_name ? 3 : 0;
}

export function nameTierAndBoost(row: PackRow, shape: QueryShape): { tier: number; boost: number } {
  if (!row.poi_name || shape.tokens.length === 0) return { tier: 3, boost: 0 };
  const name = foldQueryText(row.poi_name);
  const q = shape.folded;
  if (name === q) return { tier: 0, boost: 24 };
  if (name.startsWith(q + " ")) {
    const extra = name.slice(q.length + 1).split(" ");
    if (extra.every((t) => /^\d+$/.test(t))) return { tier: 2, boost: 8 };
    return { tier: 1, boost: Math.max(12, 24 - 2 * extra.length) };
  }
  if (q.startsWith(name + " ")) return { tier: 1, boost: 10 };
  const nameTokens = new Set(name.split(" "));
  if (shape.tokens.every((t) => nameTokens.has(t))) return { tier: 2, boost: 6 };
  return { tier: 3, boost: 0 };
}

export interface ScoredRow {
  row: PackRow;
  /** 黄金门口径的检索分数（覆盖 + trigram + weight）。 */
  score: number;
  tier: number;
  rankScore: number;
}

/** 给已打分的候选加上排序层（tier + 名字加权 + 显著度）并排序。
 *  地址形查询不加显著度（门牌地址之间比的是覆盖与权重），但名字
 *  tier 仍参与——用户把机构名和地址一起打全时，命名行优先是合理的。 */
export function rankCandidates(scored: Array<{ row: PackRow; score: number }>, shape: QueryShape): ScoredRow[] {
  const out: ScoredRow[] = scored.map(({ row, score }) => {
    const { tier, boost } = nameTierAndBoost(row, shape);
    const prominence = shape.poiShaped ? categoryProminence(row) : 0;
    return { row, score, tier, rankScore: score + boost + prominence };
  });
  out.sort((a, b) => a.tier - b.tier || b.rankScore - a.rankScore || a.row.cid - b.row.cid);
  return out;
}

// ---------------------------------------------------------------------------
// 排序层二：单元行折叠（响应组装层，包数据不动）。
// 折叠键 = 名字 + 门牌 + 街名 + 类型 + 区 + 州 + 邮编（全折叠），
// 与 unit 无关——同组行只差单元号。代表行选择：
//   查询显式写了单元号且组里有 → 就是那一行（label 带单元号）；
//   否则有裸行（unit 为空）用裸行；再否则用排名最高的那行做代表、
//   label 去掉「单元/」前缀。无论哪种，整组的单元号都挂在 units 上。
// ---------------------------------------------------------------------------

export function unitGroupKey(row: PackRow): string {
  return [
    foldQueryText(row.poi_name),
    row.number.toUpperCase(),
    foldQueryText(row.street_name),
    foldQueryText(row.street_type),
    foldQueryText(row.suburb),
    row.state.toUpperCase(),
    row.postcode,
  ].join("|");
}

function sortUnits(units: string[]): string[] {
  return [...units].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** PackRow → 客户端认的建议形状（与 Photon 适配层同构）。
 *  label：POI 行把名字放最前面（G-NAF 命名行的 display 不带名字，
 *  OSM POI 行的 display 已带——已带的不重复加）。 */
export function packSuggestion(row: PackRow, country: string, labelOverride?: string): GeoSuggestion {
  let label = labelOverride ?? row.display;
  if (labelOverride === undefined && row.poi_name && !row.display.toLowerCase().startsWith(row.poi_name.toLowerCase())) {
    label = `${row.poi_name}, ${row.display}`;
  }
  const suggestion: GeoSuggestion = { label };
  if (row.poi_name) suggestion.name = row.poi_name;
  const streetLine = [row.street_name, titleCase(row.street_type), row.number].filter(Boolean).join(" ");
  if (streetLine) suggestion.street = streetLine;
  if (row.suburb) suggestion.suburb = row.suburb;
  if (row.state) suggestion.state = row.state;
  if (row.postcode) suggestion.postcode = row.postcode;
  if (country) suggestion.country = country;
  if (row.lat !== null && row.lon !== null) {
    suggestion.lat = row.lat;
    suggestion.lon = row.lon;
  }
  return suggestion;
}

/** 已排序候选 → 折叠后的建议列表（≤ limit 条）。 */
export function foldUnitGroups(ranked: ScoredRow[], shape: QueryShape, country: string, limit: number): GeoSuggestion[] {
  const groups = new Map<string, ScoredRow[]>();
  const order: string[] = [];
  for (const item of ranked) {
    const key = unitGroupKey(item.row);
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(item);
  }

  const out: GeoSuggestion[] = [];
  for (const key of order) {
    if (out.length >= limit) break;
    const members = groups.get(key)!;
    const units = sortUnits([...new Set(members.map((m) => m.row.unit).filter(Boolean))]);
    const bare = members.find((m) => !m.row.unit);
    let rep = bare ?? members[0]!;
    let repIsSpecificUnit = false;
    if (shape.unit) {
      const hit = members.find((m) => m.row.unit.toUpperCase() === shape.unit);
      if (hit) {
        rep = hit;
        repIsSpecificUnit = true;
      }
    }
    let label: string | undefined;
    if (!repIsSpecificUnit && rep.row.unit) {
      // 没有裸行、又不是用户点名的单元：label 用不带单元前缀的写法，
      // 单元清单挂在 units 里，客户端可展开。
      const prefix = `${rep.row.unit}/`;
      label = rep.row.display.startsWith(prefix) ? rep.row.display.slice(prefix.length) : rep.row.display;
      if (rep.row.poi_name && !label.toLowerCase().startsWith(rep.row.poi_name.toLowerCase())) {
        label = `${rep.row.poi_name}, ${label}`;
      }
    }
    const suggestion = packSuggestion(rep.row, country, label);
    if (repIsSpecificUnit) suggestion.unit = rep.row.unit;
    if (units.length > 0) suggestion.units = units;
    out.push(suggestion);
  }
  return out;
}

// ---------------------------------------------------------------------------
// sqlite 访问：懒加载 node:sqlite + 包发现 + 黄金门口径检索。
// 句柄按目录缓存，文件 mtime 变了就重开（同步通道换包不用重启进程）。
// ---------------------------------------------------------------------------

interface SqliteDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

interface OpenPack {
  file: string;
  mtimeMs: number;
  db: SqliteDb;
  country: string;
}

let sqliteCtor: (new (file: string, opts?: { readOnly?: boolean }) => SqliteDb) | null | undefined;
let openCache: { dir: string; packs: OpenPack[] } | null = null;

async function loadSqlite(): Promise<typeof sqliteCtor> {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb;
    };
    sqliteCtor = mod.DatabaseSync;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

/** 选包：全国包（pack-au.sqlite）含全部州数据，有它就只用它；
 *  没有全国包时用目录里全部 pack-*.sqlite（各州包互不重叠）。 */
export function choosePackFiles(files: string[]): string[] {
  const packs = files.filter((f) => /^pack-[a-z0-9-]+\.sqlite$/i.test(f)).sort();
  if (packs.includes("pack-au.sqlite")) return ["pack-au.sqlite"];
  return packs;
}

async function openPacks(dir: string): Promise<OpenPack[]> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    openCache = { dir, packs: [] };
    return [];
  }
  const chosen = choosePackFiles(files);
  const stats = new Map<string, number>();
  for (const f of chosen) {
    try {
      stats.set(f, statSync(path.join(dir, f)).mtimeMs);
    } catch {
      /* 文件刚被换掉也别抛，跳过 */
    }
  }
  if (
    openCache &&
    openCache.dir === dir &&
    openCache.packs.length === stats.size &&
    openCache.packs.every((p) => stats.get(path.basename(p.file)) === p.mtimeMs)
  ) {
    return openCache.packs;
  }
  for (const p of openCache?.packs ?? []) {
    try { p.db.close(); } catch { /* 已关 */ }
  }
  const Db = await loadSqlite();
  const packs: OpenPack[] = [];
  if (Db) {
    for (const f of chosen) {
      const full = path.join(dir, f);
      const mtimeMs = stats.get(f);
      if (mtimeMs === undefined) continue;
      try {
        const db = new Db(full, { readOnly: true });
        // 形状校验：三张表缺一不可，形状不对的 .sqlite 不能当包用。
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>)
          .map((r) => r.name);
        if (!tables.includes("addresses") || !tables.includes("addr_fts") || !tables.includes("addr_tri")) {
          db.close();
          continue;
        }
        let country = "";
        try {
          const meta = db.prepare("SELECT value FROM meta WHERE key = 'country'").get() as { value?: string } | undefined;
          if (meta?.value) country = meta.value === "AU" ? "Australia" : meta.value;
        } catch { /* meta 缺失不致命 */ }
        packs.push({ file: full, mtimeMs, db, country });
      } catch {
        /* 打不开就跳过这个包，降级由上层处理 */
      }
    }
  }
  openCache = { dir, packs };
  return packs;
}

const ROW_COLUMNS =
  "cid, display, unit, number, street_name, street_type, suburb, state, postcode, poi_name, category, weight, lat, lon, sources";

function toRow(r: Record<string, unknown>): PackRow {
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    cid: Number(r.cid ?? 0),
    display: s(r.display),
    unit: s(r.unit),
    number: s(r.number),
    street_name: s(r.street_name),
    street_type: s(r.street_type),
    suburb: s(r.suburb),
    state: s(r.state),
    postcode: s(r.postcode),
    poi_name: s(r.poi_name),
    category: s(r.category),
    weight: typeof r.weight === "number" ? r.weight : 0,
    lat: n(r.lat),
    lon: n(r.lon),
    sources: s(r.sources),
  };
}

/** 单个包内检索：召回（FTS + trigram）→ 黄金门打分。返回未排序候选。 */
function searchOnePack(pack: OpenPack, shape: QueryShape): Array<{ row: PackRow; score: number }> {
  const toks = shape.tokens;
  if (toks.length === 0) return [];
  const cand = new Map<number, string>();
  const match = toks.map((t) => `"${t}"*`).join(" AND ");
  const tier1 = pack.db
    .prepare("SELECT rowid, search_text FROM addr_fts WHERE addr_fts MATCH ? LIMIT 5000")
    .all(match) as Array<{ rowid: number; search_text: string }>;
  for (const r of tier1) cand.set(r.rowid, r.search_text);

  const tris = trigramsOf(toks);
  if (tris.size > 0) {
    const mq = [...tris].sort().map((x) => `"${x}"`).join(" OR ");
    const tier2 = pack.db
      .prepare("SELECT rowid, search_text FROM addr_tri WHERE addr_tri MATCH ? ORDER BY bm25(addr_tri) LIMIT 2000")
      .all(mq) as Array<{ rowid: number; search_text: string }>;
    for (const r of tier2) if (!cand.has(r.rowid)) cand.set(r.rowid, r.search_text);
  }
  if (cand.size === 0) return [];

  const cids = [...cand.keys()];
  const rows = new Map<number, PackRow>();
  const CHUNK = 900;
  for (let i = 0; i < cids.length; i += CHUNK) {
    const slice = cids.slice(i, i + CHUNK);
    const found = pack.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM addresses WHERE cid IN (${slice.map(() => "?").join(",")})`)
      .all(...slice) as Array<Record<string, unknown>>;
    for (const r of found) rows.set(Number(r.cid), toRow(r));
  }

  const scored: Array<{ row: PackRow; score: number }> = [];
  for (const [cid, stext] of cand) {
    const row = rows.get(cid);
    if (!row) continue;
    const rtoks = new Set(stext.split(/[^a-z0-9]+/).filter(Boolean));
    let s = 0;
    let covered = 0;
    for (const t of toks) {
      if (rtoks.has(t)) {
        s += /^\d+$/.test(t) ? 6 : 3;
        covered++;
      } else if ([...rtoks].some((x) => x.startsWith(t))) {
        s += 1;
        covered++;
      }
    }
    if (covered === toks.length) s += 5;
    let triRatio = 0;
    if (tris.size > 0) {
      const rtris = new Set<string>();
      for (const rt of rtoks) for (let i = 0; i + 3 <= rt.length; i++) rtris.add(rt.slice(i, i + 3));
      let overlap = 0;
      for (const t of tris) if (rtris.has(t)) overlap++;
      triRatio = overlap / tris.size;
      s += triRatio * 8;
    }
    // 相关性下限（黄金门不需要这条——它只看 top-3；suggest 要返回
    // 一整列，零覆盖候选光靠 weight×0.5 就能蹭进列表）：至少命中
    // 一个 token（精确或前缀），或 trigram 重叠过半（整词打错时
    // 每个 token 都命不中，只能靠这一条活下来）。
    if (covered === 0 && triRatio < 0.5) continue;
    scored.push({ row, score: s + row.weight * 0.5 });
  }
  return scored;
}

/** 本地包建议入口：与 fetchPhotonSuggestions 同口径——任何失败回 []。 */
export async function fetchPackSuggestions(args: {
  packDir?: string | null;
  query: string;
  limit: number;
}): Promise<GeoSuggestion[]> {
  try {
    if (!args.packDir) return [];
    const shape = analyzeQuery(args.query);
    if (shape.tokens.length === 0) return [];
    const packs = await openPacks(args.packDir);
    if (packs.length === 0) return [];
    const merged: Array<{ row: PackRow; score: number }> = [];
    let country = "";
    for (const pack of packs) {
      if (!country && pack.country) country = pack.country;
      merged.push(...searchOnePack(pack, shape));
    }
    if (merged.length === 0) return [];
    const ranked = rankCandidates(merged, shape);
    return foldUnitGroups(ranked, shape, country, args.limit);
  } catch {
    return [];
  }
}

/** 测试用：清掉句柄缓存（夹具包换目录时用）。 */
export function _resetGeoPackCacheForTests(): void {
  for (const p of openCache?.packs ?? []) {
    try { p.db.close(); } catch { /* 已关 */ }
  }
  openCache = null;
  sqliteCtor = undefined;
}
