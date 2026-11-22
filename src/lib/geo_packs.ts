// 后台「地址包」页的数据层：扫 GEO_PACK_DIR，把管线产出的包和配套
// 文件（manifest / licence-manifest / ATTRIBUTION / licences/）整理成
// 清单，并给下载接口做白名单校验。
//
// 安全口径：下载只认扫描时真实存在、且文件名命中包文件命名规则的
// 条目，请求里的文件名只做白名单查表，永远不拼路径——目录穿越在
// 这一层就被挡掉。元数据（行数 / sha256 / 生成时间）取自 manifest，
// 本模块不打开 sqlite（9.47 GiB 的包更不该为列表页读一遍）；包内嵌
// 的许可/署名由 lib/geo_pack_attribution.ts 在清单页单独补读（只查
// meta 三个键），填充到 GeoPackInfo.embedded。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EmbeddedPackAttribution } from "./geo_pack_attribution.js";

export interface GeoPackFileEntry {
  /** 下载用的文件名（相对包目录，licences/ 下的带 licences/ 前缀）。 */
  name: string;
  bytes: number;
  kind: "pack" | "manifest" | "licence" | "attribution" | "licence-text";
}

export interface GeoPackInfo {
  /** 包 id（pack-au.sqlite → au，pack-au-vic.sqlite → au-vic）。 */
  id: string;
  file: string;
  bytes: number;
  rows: number | null;
  sha256: string | null;
  buildDate: string | null;
  packVersion: string | null;
  region: string | null;
  /** 这个包的配套文件（manifest / licence-manifest / ATTRIBUTION）。 */
  companions: GeoPackFileEntry[];
  /** 包内嵌的许可/署名（meta 三键）；listGeoPacks 本身不读 sqlite，
   *  由 attachEmbeddedAttribution 填充，旧包/未填充时为 null。 */
  embedded: EmbeddedPackAttribution | null;
}

export interface GeoPackListing {
  configured: boolean;
  packs: GeoPackInfo[];
  /** 不属于任何单个包的共享文件（顶层 manifest.json 等、licences/ 全文）。 */
  sharedFiles: GeoPackFileEntry[];
}

const PACK_FILE_RE = /^pack-([a-z0-9-]+)\.sqlite$/i;
const MANIFEST_RE = /^manifest-([a-z0-9-]+)\.json$/i;
const LICENCE_MANIFEST_RE = /^licence-manifest-([a-z0-9-]+)\.json$/i;
const ATTRIBUTION_RE = /^attribution-([a-z0-9-]+)\.txt$/i;

interface ManifestShape {
  pack_id?: string;
  region?: string;
  pack_version?: string;
  build_date?: string;
  file?: string;
  bytes?: number;
  sha256?: string;
  rows_total?: number;
}

async function readManifest(full: string): Promise<ManifestShape | null> {
  try {
    const parsed = JSON.parse(await readFile(full, "utf8")) as ManifestShape;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function entryOf(dir: string, name: string, kind: GeoPackFileEntry["kind"]): Promise<GeoPackFileEntry | null> {
  try {
    const st = await stat(path.join(dir, name));
    if (!st.isFile()) return null;
    return { name, bytes: st.size, kind };
  } catch {
    return null;
  }
}

export async function listGeoPacks(dir: string | undefined | null): Promise<GeoPackListing> {
  if (!dir) return { configured: false, packs: [], sharedFiles: [] };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // 目录配了但不存在/不可读：按「已配置、无包」呈现，后台能看出问题，
    // suggest 侧本来就走回落，不受影响。
    return { configured: true, packs: [], sharedFiles: [] };
  }

  const companionsById = new Map<string, GeoPackFileEntry[]>();
  const sharedFiles: GeoPackFileEntry[] = [];
  const pushCompanion = (id: string, e: GeoPackFileEntry | null) => {
    if (!e) return;
    const list = companionsById.get(id) ?? [];
    list.push(e);
    companionsById.set(id, list);
  };

  const packFiles: Array<{ id: string; file: string }> = [];
  const manifests = new Map<string, ManifestShape | null>();
  let genericManifest: ManifestShape | null = null;

  for (const name of names) {
    const packMatch = PACK_FILE_RE.exec(name);
    if (packMatch) {
      packFiles.push({ id: packMatch[1]!.toLowerCase(), file: name });
      continue;
    }
    const manMatch = MANIFEST_RE.exec(name);
    if (manMatch) {
      const id = manMatch[1]!.toLowerCase();
      manifests.set(id, await readManifest(path.join(dir, name)));
      pushCompanion(id, await entryOf(dir, name, "manifest"));
      continue;
    }
    const licMatch = LICENCE_MANIFEST_RE.exec(name);
    if (licMatch) {
      pushCompanion(licMatch[1]!.toLowerCase(), await entryOf(dir, name, "licence"));
      continue;
    }
    const attrMatch = ATTRIBUTION_RE.exec(name);
    if (attrMatch) {
      pushCompanion(attrMatch[1]!.toLowerCase(), await entryOf(dir, name, "attribution"));
      continue;
    }
    if (name === "manifest.json" || name === "licence-manifest.json" || name === "ATTRIBUTION.txt") {
      const kind = name === "ATTRIBUTION.txt" ? "attribution" : name === "manifest.json" ? "manifest" : "licence";
      const e = await entryOf(dir, name, kind);
      if (e) sharedFiles.push(e);
      if (name === "manifest.json") genericManifest = await readManifest(path.join(dir, name));
    }
  }

  // licences/ 下的许可全文是全包共享的。
  try {
    for (const name of await readdir(path.join(dir, "licences"))) {
      // 许可文件名带版本号（odbl-1.0.txt / cc-by-4.0.txt），点要放行；
      // 但不许出现 ".." 片段。
      if (!/^[a-z0-9][a-z0-9.-]*\.txt$/i.test(name) || name.includes("..")) continue;
      const e = await entryOf(dir, path.join("licences", name), "licence-text");
      if (e) {
        e.name = `licences/${name}`;
        sharedFiles.push(e);
      }
    }
  } catch {
    /* 没有 licences/ 目录就算了 */
  }

  const packs: GeoPackInfo[] = [];
  for (const { id, file } of packFiles.sort((a, b) => a.file.localeCompare(b.file))) {
    const self = await entryOf(dir, file, "pack");
    if (!self) continue;
    const manifest = manifests.get(id) ?? (genericManifest?.pack_id === id ? genericManifest : null);
    packs.push({
      id,
      file,
      bytes: self.bytes,
      rows: typeof manifest?.rows_total === "number" ? manifest.rows_total : null,
      sha256: typeof manifest?.sha256 === "string" ? manifest.sha256 : null,
      buildDate: typeof manifest?.build_date === "string" ? manifest.build_date : null,
      packVersion: typeof manifest?.pack_version === "string" ? manifest.pack_version : null,
      region: typeof manifest?.region === "string" ? manifest.region : null,
      companions: companionsById.get(id) ?? [],
      embedded: null,
    });
  }
  return { configured: true, packs, sharedFiles };
}

/** 下载白名单：把请求的文件名对到扫描结果上，命中才返回绝对路径。
 *  只接受单个文件名或 licences/<name>.txt 两种形状，其余一律 null。 */
export async function resolveGeoPackDownload(
  dir: string | undefined | null,
  requested: string,
): Promise<{ full: string; name: string; bytes: number } | null> {
  if (!dir || !requested) return null;
  if (requested.includes("\\") || requested.includes("\0")) return null;
  const listing = await listGeoPacks(dir);
  const all: GeoPackFileEntry[] = [
    ...listing.packs.map((p) => ({ name: p.file, bytes: p.bytes, kind: "pack" as const })),
    ...listing.packs.flatMap((p) => p.companions),
    ...listing.sharedFiles,
  ];
  const hit = all.find((e) => e.name === requested);
  if (!hit) return null;
  const full = path.join(dir, hit.name);
  // 最后一道：解析后的真实路径必须还在包目录内。
  const root = path.resolve(dir);
  if (!path.resolve(full).startsWith(root + path.sep)) return null;
  return { full, name: hit.name, bytes: hit.bytes };
}
