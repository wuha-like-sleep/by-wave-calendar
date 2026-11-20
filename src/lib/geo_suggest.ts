// 地址联想的在线兜底 —— 纯逻辑部分（组装标签、语言映射、结果整形）。
//
// 产品口径（用户定的）：建议永远先来自各客户端的本地地址簿；本地命中
// 太少时才问这一层。这一层只是「建议来源」，不是数据源：上游查不到、
// 超时、格式不对，一律返回空数组，客户端静默退回本地建议，绝不报错、
// 绝不挡保存。在线结果被用户选中后会写回本地地址簿，所以这一层会被
// 用得越来越少。
//
// 上游是 Photon（Komoot 运营，数据来自 OpenStreetMap，无需 API key）。
// 注意两条 Photon 的硬约束：
//   - lang 只支持 default / de / en / fr，其余语言传过去会直接报错，
//     所以映射在服务端做：支持的原样传，不支持的用 default（OSM 本地名）。
//   - 公共实例的用量政策要求调用方收敛频率——路由层有缓存 + 限流，
//     客户端只在本地命中 < 3 条时才发请求，且有去抖。

/** Photon 返回的 properties 里我们用到的字段（其余忽略）。 */
export interface PhotonProperties {
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  postcode?: string;
  state?: string;
  country?: string;
}

export interface PhotonFeature {
  properties?: PhotonProperties;
}

export interface GeoSuggestion {
  /** 展示 + 回填输入框的完整地址串。 */
  label: string;
}

/** 把任意 UI 语言映射到 Photon 支持的 lang 取值。 */
export function photonLang(uiLang: string | undefined | null): string {
  const base = String(uiLang ?? "").toLowerCase().split("-")[0];
  if (base === "de" || base === "en" || base === "fr") return base;
  return "default";
}

function clean(part: string | undefined): string {
  return String(part ?? "").trim();
}

/**
 * 把一条 Photon 结果组装成一行可读地址：
 * 名称、街道门牌、城市、州/省、国家，跳过空段和与前一段重复的段
 * （OSM 里 name 经常就等于 street 或 city，原样拼会出「Melbourne,
 * Melbourne」这种笑话）。名称缺失时以街道打头；街道也没有就用城市。
 */
export function photonLabel(props: PhotonProperties): string {
  const streetLine = [clean(props.street), clean(props.housenumber)]
    .filter(Boolean)
    .join(" ");
  const rawParts = [
    clean(props.name),
    streetLine,
    clean(props.locality),
    clean(props.district),
    clean(props.city),
    clean(props.state),
    clean(props.country),
  ];
  const parts: string[] = [];
  for (const part of rawParts) {
    if (!part) continue;
    const prev = parts[parts.length - 1];
    if (prev !== undefined && prev.toLowerCase() === part.toLowerCase()) continue;
    // name 与街道/城市完全相同时只留一份（留先出现的，通常是 name）。
    if (parts.some((p) => p.toLowerCase() === part.toLowerCase())) continue;
    parts.push(part);
  }
  // 邮编插在城市后面更符合地址习惯；没有城市就跟在最后一段之前无处安放，
  // 直接并进城市位（城市为空时单独成段也无妨）。
  const postcode = clean(props.postcode);
  if (postcode && !parts.some((p) => p.includes(postcode))) {
    const cityIdx = parts.findIndex((p) => p.toLowerCase() === clean(props.city).toLowerCase());
    if (cityIdx >= 0) parts[cityIdx] = `${parts[cityIdx]} ${postcode}`;
    else if (parts.length > 0) parts.splice(parts.length - 1, 0, postcode);
  }
  return parts.join(", ");
}

/** Photon 响应 → 建议列表：去空、去重（按小写标签）、截断。 */
export function photonSuggestions(body: unknown, limit: number): GeoSuggestion[] {
  const features = (body as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: GeoSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const props = (f as PhotonFeature)?.properties;
    if (!props) continue;
    const label = photonLabel(props);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 带超时地问 Photon。任何失败（网络、超时、非 200、JSON 坏了）都返回
 * 空数组——调用方不需要、也不应该区分失败原因。
 */
export async function fetchPhotonSuggestions(args: {
  baseUrl: string;
  query: string;
  lang: string | undefined;
  limit: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<GeoSuggestion[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    q: args.query,
    limit: String(args.limit),
    lang: photonLang(args.lang),
  });
  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return [];
    const body: unknown = await resp.json().catch(() => null);
    if (!body) return [];
    return photonSuggestions(body, args.limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 路由用的进程内缓存：同一个（语言，查询）短时间内只问一次上游。
 * 条目数封顶，超了清最早写入的——建议查询是高频小数据，不值得为它
 * 引入正经 LRU 依赖。TTL 到期惰性删除。
 */
export class GeoSuggestCache {
  private readonly entries = new Map<string, { at: number; value: GeoSuggestion[] }>();

  constructor(
    private readonly ttlMs: number = 10 * 60 * 1000,
    private readonly maxEntries: number = 500,
  ) {}

  static key(lang: string | undefined, query: string): string {
    return `${photonLang(lang)}:${query.trim().toLowerCase()}`;
  }

  get(key: string): GeoSuggestion[] | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: GeoSuggestion[]): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { at: Date.now(), value });
  }
}
