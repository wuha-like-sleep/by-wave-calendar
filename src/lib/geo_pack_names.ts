// 地址包的人话名字：包 id（au-nsw）→ 地区正式名称（新南威尔士州）。
//
// 后台列表页以前拿文件名 pack-au-nsw.sqlite 当标题，管理员看不懂
// 哪个包是哪儿。本模块把 id 拆成国家码 + 地区码，名字走 i18n：
//   adminGeoPacks.geo.country.<国家码>
//   adminGeoPacks.geo.region.<国家码>.<地区码>
//   adminGeoPacks.geo.nationalName（全国包的标题模板，{country} 占位）
// 以后加国家/地区，只往语言包里加键，不用改代码。某个码还没有译名
// 时回落：地区名 → 包 manifest 里的 region 原文（管线写的英文名）
// → 大写代码；国家名 → 大写代码。translate 对缺键返回键本身，靠
// 「译文 === 键」判缺。

export type GeoTranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export interface GeoPackIdParts {
  /** 国家码（id 第一段，小写，如 au）。 */
  country: string;
  /** 地区码（id 其余段，如 nsw / ot）；全国包为 null。 */
  region: string | null;
}

export function parseGeoPackId(packId: string): GeoPackIdParts {
  const seg = packId.toLowerCase().split("-").filter((s) => s.length > 0);
  if (seg.length === 0) return { country: "", region: null };
  return { country: seg[0]!, region: seg.length > 1 ? seg.slice(1).join("-") : null };
}

export interface GeoPackNameInfo {
  country: string;
  region: string | null;
  /** 全国包（id 只有国家码）。 */
  national: boolean;
  /** 国家的人话名（组标题用）。 */
  countryName: string;
  /** 这一行包的人话名（地区名 / 全国包模板）。 */
  name: string;
}

export function geoPackNameInfo(
  t: GeoTranslateFn,
  packId: string,
  manifestRegion: string | null,
): GeoPackNameInfo {
  const { country, region } = parseGeoPackId(packId);
  const countryKey = `adminGeoPacks.geo.country.${country}`;
  const countryTx = country ? t(countryKey) : countryKey;
  const countryName = countryTx !== countryKey ? countryTx : country.toUpperCase();
  if (!region) {
    const key = "adminGeoPacks.geo.nationalName";
    const tx = t(key, { country: countryName });
    return { country, region, national: true, countryName, name: tx !== key ? tx : countryName };
  }
  const regionKey = `adminGeoPacks.geo.region.${country}.${region}`;
  const regionTx = t(regionKey);
  const name = regionTx !== regionKey ? regionTx : (manifestRegion ?? region.toUpperCase());
  return { country, region, national: false, countryName, name };
}

/** 组内排序：全国包在前；已知地区按 AU 的习惯顺序（人口大州在前、
 *  领地在后），未知地区码排最后按字母序。返回 [档位, 次序键]。 */
const AU_REGION_ORDER = ["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act", "ot"];

export function geoPackSortRank(parts: GeoPackIdParts): [number, string] {
  if (!parts.region) return [0, ""];
  if (parts.country === "au") {
    const idx = AU_REGION_ORDER.indexOf(parts.region);
    if (idx >= 0) return [1, String(idx).padStart(3, "0")];
  }
  return [2, parts.region];
}
