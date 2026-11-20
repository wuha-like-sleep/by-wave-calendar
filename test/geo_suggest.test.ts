// 地址联想在线兜底的纯逻辑口径（lib/geo_suggest.ts）：
// 语言映射只认 Photon 支持的集合、标签组装去重、失败一律空数组、
// 缓存 TTL 与容量上限。上游请求靠注入的 fetchImpl 打桩，不碰真网。
import { describe, it, expect } from "vitest";
import {
  photonLang,
  photonLabel,
  photonSuggestions,
  fetchPhotonSuggestions,
  GeoSuggestCache,
} from "../src/lib/geo_suggest.js";

describe("photonLang", () => {
  it("支持的语言原样传（带地区后缀也认）", () => {
    expect(photonLang("en")).toBe("en");
    expect(photonLang("en-US")).toBe("en");
    expect(photonLang("de")).toBe("de");
    expect(photonLang("fr-CA")).toBe("fr");
  });

  it("不支持的语言一律 default（Photon 对 zh/ja/ko 会直接报错）", () => {
    expect(photonLang("zh-CN")).toBe("default");
    expect(photonLang("ja")).toBe("default");
    expect(photonLang("ko")).toBe("default");
    expect(photonLang(undefined)).toBe("default");
    expect(photonLang("")).toBe("default");
  });
});

describe("photonLabel", () => {
  it("名称 + 街道门牌 + 城市邮编 + 州 + 国家", () => {
    expect(
      photonLabel({
        name: "Melbourne Central",
        street: "La Trobe Street",
        city: "Melbourne",
        postcode: "3000",
        state: "Victoria",
        country: "Australia",
      }),
    ).toBe("Melbourne Central, La Trobe Street, Melbourne 3000, Victoria, Australia");
  });

  it("名称与城市同名时不重复", () => {
    expect(
      photonLabel({ name: "Melbourne", city: "Melbourne", country: "Australia" }),
    ).toBe("Melbourne, Australia");
  });

  it("什么都没有就空串", () => {
    expect(photonLabel({})).toBe("");
  });
});

describe("photonSuggestions", () => {
  it("去重、去空、截断", () => {
    const body = {
      features: [
        { properties: { name: "A", city: "X" } },
        { properties: { name: "A", city: "X" } },
        { properties: {} },
        { properties: { name: "B", city: "Y" } },
        { properties: { name: "C", city: "Z" } },
      ],
    };
    expect(photonSuggestions(body, 2)).toEqual([
      { label: "A, X", name: "A", city: "X" },
      { label: "B, Y", name: "B", city: "Y" },
    ]);
  });

  it("组件与坐标一起带出（客户端要学进本地地址簿）", () => {
    const body = {
      features: [
        {
          properties: {
            name: "Melbourne Central", street: "La Trobe Street", housenumber: "211",
            district: "Melbourne CBD", city: "Melbourne", postcode: "3000",
            state: "Victoria", country: "Australia",
          },
          geometry: { coordinates: [144.9628, -37.8104] },
        },
      ],
    };
    expect(photonSuggestions(body, 5)).toEqual([{
      label: "Melbourne Central, La Trobe Street 211, Melbourne CBD, Melbourne 3000, Victoria, Australia",
      name: "Melbourne Central",
      street: "La Trobe Street 211",
      suburb: "Melbourne CBD",
      city: "Melbourne",
      state: "Victoria",
      postcode: "3000",
      country: "Australia",
      lat: -37.8104,
      lon: 144.9628,
    }]);
  });

  it("形状不对就空数组", () => {
    expect(photonSuggestions(null, 5)).toEqual([]);
    expect(photonSuggestions({ features: "nope" }, 5)).toEqual([]);
  });
});

describe("fetchPhotonSuggestions", () => {
  const base = { baseUrl: "https://photon.example", query: "Melbourne Central", lang: "en", limit: 5, timeoutMs: 1000 };

  it("成功时整形返回，并把 lang 映射后带上", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: unknown) => {
      seenUrl = String(url);
      return {
        ok: true,
        json: async () => ({ features: [{ properties: { name: "Melbourne Central", city: "Melbourne" } }] }),
      } as Response;
    }) as typeof fetch;
    const out = await fetchPhotonSuggestions({ ...base, lang: "zh-CN", fetchImpl });
    expect(out).toEqual([{ label: "Melbourne Central, Melbourne", name: "Melbourne Central", city: "Melbourne" }]);
    expect(seenUrl).toContain("lang=default");
    expect(seenUrl).toContain("q=Melbourne+Central");
  });

  it("非 200 返回空数组", async () => {
    const fetchImpl = (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;
    expect(await fetchPhotonSuggestions({ ...base, fetchImpl })).toEqual([]);
  });

  it("抛错返回空数组", async () => {
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await fetchPhotonSuggestions({ ...base, fetchImpl })).toEqual([]);
  });
});

describe("GeoSuggestCache", () => {
  it("命中、过期、容量淘汰", () => {
    const cache = new GeoSuggestCache(1000, 2);
    cache.set("k1", [{ label: "A" }]);
    expect(cache.get("k1")).toEqual([{ label: "A" }]);
    cache.set("k2", [{ label: "B" }]);
    cache.set("k3", [{ label: "C" }]); // 容量 2 → 最早的 k1 被淘汰
    expect(cache.get("k1")).toBeNull();
    expect(cache.get("k3")).toEqual([{ label: "C" }]);
  });

  it("key 归一化：语言映射 + 查询去空白小写", () => {
    expect(GeoSuggestCache.key("zh-CN", "  Melbourne ")).toBe("default:melbourne");
    expect(GeoSuggestCache.key("en", "Melbourne")).toBe("en:melbourne");
  });
});
