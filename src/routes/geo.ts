// GET /geo/suggest?q=&lang= —— 地址联想的在线兜底代理。
//
// 为什么要服务端代理、而不是客户端直连 Photon：
//   - Photon 公共实例的用量政策不允许全网客户端各打各的；收敛到服务端
//     才能做缓存 + 限流，替上游省流量，也替我们自己兜住滥用。
//   - 无状态：不落库、不记用户查了什么。缓存只在进程内存里（key 是
//     语言+查询串，不含用户 id），重启即清。
//
// 鉴权与其它读接口一致（requireUserOrSend：会话 / Bearer / OAuth 都行），
// 不开匿名口——这不是给全网用的免费代理。限流沿用站内纪律（30 次/分钟，
// 与 /search 同档）。任何上游失败都回 200 + 空列表：客户端的设计前提
// 就是「在线建议可有可无」，报错只会把本地建议也拖下水。

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUserOrSend } from "../lib/session.js";
import { env } from "../env.js";
import {
  GeoSuggestCache,
  fetchGeoSuggestions,
  type GeoSuggestion,
} from "../lib/geo_suggest.js";

const EMPTY: { suggestions: GeoSuggestion[] } = { suggestions: [] };
const cache = new GeoSuggestCache();

export async function geoRoutes(app: FastifyInstance) {
  app.get(
    "/geo/suggest",
    {
      config: {
        oauthScope: "read:events",
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const parsed = z
        .object({
          q: z.string().trim().min(2).max(100),
          lang: z.string().trim().max(20).optional(),
        })
        .safeParse(req.query);
      if (!parsed.success) return reply.send(EMPTY);

      const { q, lang } = parsed.data;
      const key = GeoSuggestCache.key(lang, q);
      const cached = cache.get(key);
      if (cached) return reply.send({ suggestions: cached });

      const suggestions = await fetchGeoSuggestions({
        provider: env.GEO_PROVIDER,
        baseUrl: env.GEO_PROVIDER_BASE_URL,
        query: q,
        lang,
        limit: 5,
        timeoutMs: 2500,
      });
      // 空结果也缓存：上游查不到的地名短时间内不会变，别让每个客户端
      // 的每次按键都再去问一遍。
      cache.set(key, suggestions);
      return reply.send({ suggestions });
    },
  );
}
