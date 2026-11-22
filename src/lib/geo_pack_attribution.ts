// 包内嵌许可/署名读取：pack_version 2026.11.4 起，打包管线把署名与
// 许可材料直接写进包 sqlite 的 meta 表，随包文件本身分发：
//   meta.attribution       —— 署名全文（纯文本）
//   meta.licence_manifest  —— 许可清单（JSON 字符串，形状与
//                             licence-manifest-<id>.json 相同）
//   meta.licences          —— 许可全文（JSON 对象 {文件名: 全文}）
// 三个键都是可选的：schema 1/2 的旧包没有，后台回落到配套文件
// （ATTRIBUTION-<id>.txt / licence-manifest-<id>.json / licences/）。
//
// 纪律与 provider 一致：只读打开、只查 meta 三个键（不读包数据），
// 任何失败（文件打不开、没有 meta 表、键缺失、JSON 坏了）一律降级
// 返回 null 或对应字段为 null，绝不抛错进请求路径。读到的文本是
// 文件内容、按不可信输入对待：调用方展示时必须走转义输出。

import path from "node:path";
import type { GeoPackListing } from "./geo_packs.js";

/** licence_manifest 里单个数据源的条目（管线记录的结论性字段）。 */
export interface EmbeddedLicenceSource {
  name: string;
  licence: string;
  dataVersion: string | null;
  attributionText: string | null;
  shareAlike: boolean | null;
  /** 明确标了 included:false 的来源（如未核许可而排除的）保留标记。 */
  included: boolean | null;
  restrictions: string[];
  note: string | null;
}

export interface EmbeddedLicenceManifest {
  packId: string | null;
  derivedDatabaseNotice: string | null;
  sources: EmbeddedLicenceSource[];
}

export interface EmbeddedPackAttribution {
  /** 署名全文（meta.attribution），没有为 null。 */
  attribution: string | null;
  /** 解析后的许可清单；键缺失或 JSON 不可用时为 null。 */
  licenceManifest: EmbeddedLicenceManifest | null;
  /** 许可全文 {文件名: 全文}；没有为 {}。 */
  licences: Record<string, string>;
}

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

let sqliteCtor: (new (file: string, opts?: { readOnly?: boolean }) => SqliteDb) | null | undefined;

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

function optString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function optBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** licence_manifest 原始 JSON → 结构化清单。形状不对（不是对象、
 *  sources 不是数组）返回 null；单个来源条目缺 name/licence 的丢弃，
 *  其余字段逐个防御性取值。 */
export function parseEmbeddedLicenceManifest(raw: string): EmbeddedLicenceManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.sources)) return null;
  const sources: EmbeddedLicenceSource[] = [];
  for (const item of rec.sources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const name = optString(s.name);
    const licence = optString(s.licence);
    if (!name || !licence) continue;
    sources.push({
      name,
      licence,
      dataVersion: optString(s.data_version),
      attributionText: optString(s.attribution_text),
      shareAlike: optBool(s.share_alike),
      included: optBool(s.included),
      restrictions: Array.isArray(s.restrictions)
        ? s.restrictions.filter((r): r is string => typeof r === "string")
        : [],
      note: optString(s.note),
    });
  }
  return {
    packId: optString(rec.pack_id),
    derivedDatabaseNotice: optString(rec.derived_database_notice),
    sources,
  };
}

/** licences 原始 JSON → {文件名: 全文}。不是对象或整体坏了返回 {}，
 *  单条值不是字符串的丢弃。 */
export function parseEmbeddedLicences(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k && typeof v === "string") out[k] = v;
  }
  return out;
}

/** 读一个包文件内嵌的许可/署名。三个键一个都没有（旧包）、文件打
 *  不开、node:sqlite 不可用——一律 null。 */
export async function readEmbeddedPackAttribution(
  packFile: string,
): Promise<EmbeddedPackAttribution | null> {
  const Db = await loadSqlite();
  if (!Db) return null;
  let db: SqliteDb | null = null;
  try {
    db = new Db(packFile, { readOnly: true });
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key IN ('attribution', 'licence_manifest', 'licences')")
      .all() as Array<{ key?: unknown; value?: unknown }>;
    const byKey = new Map<string, string>();
    for (const r of rows) {
      if (typeof r.key === "string" && typeof r.value === "string" && r.value.length > 0) {
        byKey.set(r.key, r.value);
      }
    }
    if (byKey.size === 0) return null;
    const manifestRaw = byKey.get("licence_manifest");
    const licencesRaw = byKey.get("licences");
    return {
      attribution: byKey.get("attribution") ?? null,
      licenceManifest: manifestRaw ? parseEmbeddedLicenceManifest(manifestRaw) : null,
      licences: licencesRaw ? parseEmbeddedLicences(licencesRaw) : {},
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 已关 */
    }
  }
}

/** 给 listGeoPacks 的清单逐包补上内嵌许可/署名（原地填充
 *  pack.embedded 并返回同一清单，方便链式调用）。清单页专用：
 *  下载白名单路径不走这里，保持「清单不打开 sqlite」的原有口径。 */
export async function attachEmbeddedAttribution(
  listing: GeoPackListing,
  dir: string | undefined | null,
): Promise<GeoPackListing> {
  if (!dir || !listing.configured) return listing;
  for (const pack of listing.packs) {
    pack.embedded = await readEmbeddedPackAttribution(path.join(dir, pack.file));
  }
  return listing;
}

/** 测试用：清掉 sqlite 构造器缓存。 */
export function _resetGeoPackAttributionCacheForTests(): void {
  sqliteCtor = undefined;
}
