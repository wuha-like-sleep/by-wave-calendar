// 后台「地址包」页的视图模型：把本地清单 + 发布索引组装成页面要
// 的分组行与顶部一句话汇总。从 web/admin.ts 抽出来单测：状态徽标
// （最新 / 有新版 / 未安装）的判定是这页的核心逻辑，不能只靠肉眼。
//
// 判定口径：本地包的版本取包目录 manifest 记录的 sha256（落位时
// 已全量验过），与发布清单里的 sha256 比对；本地 manifest 缺
// sha256 时回落比字节数。发布索引拿不到（releaseIndex = null）时
// 已装包只标「已安装」，不冒充「最新」。

import type { GeoPackInfo } from "./geo_packs.js";
import type { GeoReleaseIndex } from "./geo_release.js";
import { geoPackNameInfo, geoPackSortRank, parseGeoPackId, type GeoTranslateFn } from "./geo_pack_names.js";

export type GeoPackRowStatus = "latest" | "update" | "installed" | "missing";

export interface GeoPackSyncInfo {
  status: string;
  received: number;
  total: number;
  updatedAt: Date;
  error: string | null;
}

export interface GeoPackPageRow {
  id: string;
  /** 本地文件名；未安装的行没有文件（不可下载），为 null。 */
  file: string | null;
  name: string;
  national: boolean;
  status: GeoPackRowStatus;
  rows: number | null;
  bytes: number;
  packVersion: string | null;
  buildDate: string | null;
  sha256: string | null;
  /** 有新版时，发布侧的版本（行上提示「可更新到」用）。 */
  releaseVersion: string | null;
  embedded: GeoPackInfo["embedded"];
  companions: GeoPackInfo["companions"];
  sync: GeoPackSyncInfo | undefined;
}

export interface GeoPackPageGroup {
  country: string;
  countryName: string;
  rows: GeoPackPageRow[];
}

export interface GeoPackPageSummary {
  installedCount: number;
  /** 全部已装包的行数合计；没有任何包报行数时为 null。 */
  totalRows: number | null;
  totalBytes: number;
  /** 已装包的版本集合（通常只有一个）。 */
  versions: string[];
  /** 最新的构建时间（manifest 的 build_date 原文）。 */
  latestBuildDate: string | null;
  /** 是否成功拿到发布索引（没拿到不许下「最新」结论）。 */
  checked: boolean;
  updateCount: number;
  missingCount: number;
}

export interface GeoPackPageModel {
  groups: GeoPackPageGroup[];
  summary: GeoPackPageSummary;
  /** packId → 人话名，预检脚本按 id 查。 */
  packNames: Record<string, string>;
}

export function buildGeoPackPageModel(args: {
  t: GeoTranslateFn;
  packs: GeoPackInfo[];
  releaseIndex: GeoReleaseIndex | null;
  syncByFile: Record<string, GeoPackSyncInfo | undefined>;
}): GeoPackPageModel {
  const { t, packs, releaseIndex, syncByFile } = args;
  const releaseById = new Map((releaseIndex?.packs ?? []).map((p) => [p.packId, p]));
  const groupMap = new Map<string, GeoPackPageGroup>();
  const pushRow = (country: string, countryName: string, row: GeoPackPageRow) => {
    const g = groupMap.get(country) ?? { country, countryName, rows: [] };
    g.rows.push(row);
    groupMap.set(country, g);
  };

  let updateCount = 0;
  for (const pack of packs) {
    const info = geoPackNameInfo(t, pack.id, pack.region);
    const rel = releaseById.get(pack.id);
    let status: GeoPackRowStatus = "installed";
    if (rel) {
      const same = pack.sha256 && rel.sha256
        ? pack.sha256.toLowerCase() === rel.sha256.toLowerCase()
        : pack.bytes === rel.bytes;
      status = same ? "latest" : "update";
      if (!same) updateCount += 1;
    }
    pushRow(info.country, info.countryName, {
      id: pack.id, file: pack.file, name: info.name, national: info.national,
      status, rows: pack.rows, bytes: pack.bytes, packVersion: pack.packVersion,
      buildDate: pack.buildDate, sha256: pack.sha256,
      releaseVersion: status === "update" ? rel?.packVersion ?? null : null,
      embedded: pack.embedded, companions: pack.companions,
      sync: syncByFile[pack.file],
    });
  }

  let missingCount = 0;
  for (const rel of releaseIndex?.packs ?? []) {
    if (packs.some((p) => p.id === rel.packId)) continue;
    missingCount += 1;
    const info = geoPackNameInfo(t, rel.packId, rel.region);
    pushRow(info.country, info.countryName, {
      id: rel.packId, file: null, name: info.name, national: info.national,
      status: "missing", rows: rel.rows, bytes: rel.bytes, packVersion: rel.packVersion,
      buildDate: null, sha256: null, releaseVersion: null,
      embedded: null, companions: [], sync: undefined,
    });
  }

  const groups = [...groupMap.values()]
    .sort((a, b) => a.country.localeCompare(b.country))
    .map((g) => ({
      ...g,
      rows: g.rows.sort((a, b) => {
        const ra = geoPackSortRank(parseGeoPackId(a.id));
        const rb = geoPackSortRank(parseGeoPackId(b.id));
        return ra[0] - rb[0] || ra[1].localeCompare(rb[1]) || a.name.localeCompare(b.name);
      }),
    }));

  const packNames: Record<string, string> = {};
  for (const g of groups) for (const r of g.rows) packNames[r.id] = r.name;

  const versions = [...new Set(packs.map((p) => p.packVersion).filter((v): v is string => !!v))];
  const buildDates = packs.map((p) => p.buildDate).filter((v): v is string => !!v).sort();
  const summary: GeoPackPageSummary = {
    installedCount: packs.length,
    totalRows: packs.some((p) => p.rows != null) ? packs.reduce((a, p) => a + (p.rows ?? 0), 0) : null,
    totalBytes: packs.reduce((a, p) => a + p.bytes, 0),
    versions,
    latestBuildDate: buildDates.length > 0 ? buildDates[buildDates.length - 1]! : null,
    checked: releaseIndex != null,
    updateCount,
    missingCount,
  };
  return { groups, summary, packNames };
}
