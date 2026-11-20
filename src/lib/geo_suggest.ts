// Photon（Komoot，基于 OpenStreetMap）地址联想的服务端适配层。
//
// 为什么要服务端代理、而不是客户端直连：
//   - Photon 公共实例的用量政策要求给足缓存与限流，散在各客户端直连
//     既不合规也兜不住滥用；收敛到服务端一处，缓存 + 限流都好做。
//   - 上游是可替换的：GEO_PROVIDER / GEO_PROVIDER_BASE_URL 决定打谁，
//     客户端只认本站的返回形状（label + 结构化组件 + 坐标）。将来换成
//     自建地址库时只动这里和 env，客户端一行不用改。
//
// 这一层只做三件事：
//   1. 语言映射：Photon 的 lang 只接受 default / de / en / fr，其它值
//      直接回 error——所以在请求前先把 UI 语言映射到这个集合里。
//   2. 结果整形：Photon 的 properties 是散字段（name/street/city/...），
//      拼成一行可直接回填的地址串（label），同时把组件与坐标原样带出，
//      客户端选中后要把它们一起学进本地地址簿。
//   3. 失败兜底：超时 / 非 200 / 坏 JSON 一律返回空数组——在线建议是
//      锦上添花，本地建议永远优先，绝不能因为在线挂了把整个联想拖垮。

/** 一条在线建议：label 是回填用的完整地址串，其余是结构化组件。 */
export interface GeoSuggestion {
  label: string;
  name?: string;
  street?: string;
  suburb?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

const PHOTON_LANGS = new Set(["de", "en", "fr"]);

/** 把任意 UI 语言码映射到 Photon 认的值。不认的语言用 "default"
 *  （Photon 按查询文本本身判断语言），不要把原值透传——会报错。 */
export function photonLang(uiLang: string | undefined | null): string {
  if (!uiLang) return "default";
  const primary = uiLang.toLowerCase().split(/[-_]/)[0] ?? "";
  return PHOTON_LANGS.has(primary) ? primary : "default";
}

interface PhotonProperties {
  name?: string;
  street?: string;
  housenumber?: string;
  district?: string;
  locality?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

/** 把 Photon 的散字段拼成一行地址。顺序按「具体 → 大范围」：
 *  名称、街道+门牌、区、城市+邮编、州、国家；相邻重复段（如 name ==
 *  city）只留一份。 */
export function photonLabel(p: PhotonProperties): string {
  const streetLine = [p.street, p.housenumber].filter(Boolean).join(" ");
  const cityLine = [p.city, p.postcode].filter(Boolean).join(" ");
  const rawParts = [p.name, streetLine, p.district ?? p.locality, cityLine, p.state, p.country];
  const parts: string[] = [];
  for (const part of rawParts) {
    if (!part) continue;
    const prev = parts[parts.length - 1];
    if (prev !== undefined && prev.toLowerCase() === part.toLowerCase()) continue;
    parts.push(part);
  }
  return parts.join(", ");
}

/** GeoJSON FeatureCollection → 建议列表。按 label 去重，截到 limit。 */
export function photonSuggestions(body: unknown, limit: number): GeoSuggestion[] {
  const features = (body as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: GeoSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const props = (f as { properties?: PhotonProperties })?.properties;
    if (!props) continue;
    const label = photonLabel(props);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const coords = (f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates;
    const suggestion: GeoSuggestion = { label };
    if (props.name) suggestion.name = props.name;
    const streetLine = [props.street, props.housenumber].filter(Boolean).join(" ");
    if (streetLine) suggestion.street = streetLine;
    const suburb = props.district ?? props.locality;
    if (suburb) suggestion.suburb = suburb;
    if (props.city) suggestion.city = props.city;
    if (props.state) suggestion.state = props.state;
    if (props.postcode) suggestion.postcode = props.postcode;
    if (props.country) suggestion.country = props.country;
    if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
      suggestion.lon = coords[0];
      suggestion.lat = coords[1];
    }
    out.push(suggestion);
    if (out.length >= limit) break;
  }
  return out;
}

export interface FetchGeoArgs {
  provider: string;
  baseUrl: string;
  query: string;
  lang?: string | null;
  limit: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** 上游分发：目前只有 photon 一个适配器。未知 provider 返回空数组
 *  （而不是抛错）——配置写错时在线建议静默消失，本地建议不受影响，
 *  和「上游挂了」的降级口径一致。 */
export async function fetchGeoSuggestions(args: FetchGeoArgs): Promise<GeoSuggestion[]> {
  switch (args.provider) {
    case "photon":
      return fetchPhotonSuggestions(args);
    default:
      return [];
  }
}

/** 打一次 Photon。任何失败都返回 []，不抛错。 */
export async function fetchPhotonSuggestions(
  args: Omit<FetchGeoArgs, "provider">,
): Promise<GeoSuggestion[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    q: args.query,
    limit: String(args.limit),
    lang: photonLang(args.lang),
  });
  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return [];
    const body: unknown = await resp.json().catch(() => null);
    return photonSuggestions(body, args.limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 进程内短缓存：同一个查询在几分钟内被多个用户/同一个人反复打是常态
 * （输一半改主意、几台设备同时在编辑），别每次都去敲上游。
 * key = 映射后的语言 + 归一化查询串，不带用户 id —— 地址建议与账号
 * 无关，没必要按用户分片。容量封顶 FIFO 淘汰，进程重启即清。
 */
export class GeoSuggestCache {
  private map = new Map<string, { at: number; value: GeoSuggestion[] }>();

  constructor(
    private ttlMs = 10 * 60 * 1000,
    private maxEntries = 500,
  ) {}

  static key(lang: string | undefined | null, query: string): string {
    return `${photonLang(lang)}:${query.trim().toLowerCase()}`;
  }

  get(key: string, now = Date.now()): GeoSuggestion[] | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: GeoSuggestion[], now = Date.now()): void {
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { at: now, value });
  }
}
