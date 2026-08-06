import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { buildIcsFeed } from "../services/ics.js";
import { env } from "../env.js";
import { getSettings } from "../lib/site_settings.js";
import path from "node:path";
import ejs from "ejs";
import { makeT, resolveLocaleFromRequest } from "../lib/i18n.js";
import { jsonForScript } from "../lib/script_json.js";

// @fastify/helmet 支持在路由的 config 里覆盖全局配置(它自己在
// onRequest 里读 request.routeOptions.config.helmet),但没有扩展
// Fastify 的类型。这里补上,免得用 as any 把整个 config 的类型丢掉。
declare module "fastify" {
  interface FastifyContextConfig {
    helmet?: {
      frameguard?: false | { action?: string };
      contentSecurityPolicy?: false | Record<string, unknown>;
      skipRoute?: boolean;
    };
  }
}

export async function icsRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/ics/:token", async (req, reply) => {
    const token = req.params.token.replace(/\.ics$/i, "");
    if (!token || token.length < 8) return reply.code(404).send({ error: "not_found" });

    const tokenRow = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.token, token), isNull(schema.shareTokens.revokedAt)))
      .limit(1);
    if (tokenRow.length === 0) return reply.code(404).send({ error: "not_found" });

    const calendarId = tokenRow[0]!.calendarId;
    const [calendar] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, calendarId))
      .limit(1);
    if (!calendar) return reply.code(404).send({ error: "not_found" });

    // Disabled-account gate: ICS share tokens outlive the user's session.
    // If the calendar owner has been disabled, stop publishing their events
    // through the public feed.
    const [owner] = await db
      .select({ disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, calendar.ownerId))
      .limit(1);
    if (!owner || owner.disabledAt) return reply.code(404).send({ error: "not_found" });

    // Soft-deleted events must NOT leak into the public feed — without this
    // filter, anyone with the share URL would still see events that the
    // owner thought they'd deleted.
    const events = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendar.id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));

    const body = buildIcsFeed(calendar, events);
    reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .header("Content-Disposition", `inline; filename="${calendar.id}.ics"`);
    return reply.send(body);
  });

  // ---------- Embeddable widget (iframe-friendly read-only calendar) ----------
  // Uses the same share-token surface as the ICS feed: anyone with the URL
  // sees the contents. Renders a stripped-down Toast UI Calendar in an
  // iframe-safe HTML page (no nav, no toolbar chrome from layout.ejs).
  app.get<{ Params: { token: string } }>("/embed/:token", {
    // 让 helmet 跳过这条路由的 frameguard 和 CSP:
    //  - frameguard 会盖 X-Frame-Options: SAMEORIGIN,而它只有
    //    DENY/SAMEORIGIN 两档,表达不了「允许这几个站点嵌入」,留着
    //    就把嵌入组件挡死(旧代码在处理器里发 ALLOWALL 想覆盖它,但
    //    helmet 走的是 onRequest + 底层 setHeader,处理器根本盖不掉,
    //    所以那段代码从来没生效过)。
    //  - CSP 由处理器按管理员白名单单独生成(见下方),不能用全局那份。
    // 其余安全响应头(HSTS / nosniff / referrer-policy 等)照常生效。
    config: { helmet: { frameguard: false, contentSecurityPolicy: false } },
  }, async (req, reply) => {
    // Site-wide kill switch from /admin/security. When off, /embed/* is
    // indistinguishable from "token doesn't exist" — 404 with no extra
    // info so we don't accidentally leak that the feature ever existed.
    const settings = await getSettings();
    if (!settings.embedEnabled) return reply.code(404).type("text/plain").send("Not Found");

    const token = req.params.token.replace(/\.html$/i, "");
    if (!token || token.length < 8) return reply.code(404).type("text/plain").send("Not Found");

    const [tokRow] = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.token, token), isNull(schema.shareTokens.revokedAt)))
      .limit(1);
    if (!tokRow) return reply.code(404).type("text/plain").send("Not Found");

    const [calendar] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, tokRow.calendarId))
      .limit(1);
    if (!calendar) return reply.code(404).type("text/plain").send("Not Found");

    // Disabled-account gate: hide the widget if the owner is disabled
    // (mirrors what we already do for the ICS feed). Indistinguishable
    // 404 so we don't leak account status.
    const [owner] = await db
      .select({ disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, calendar.ownerId))
      .limit(1);
    if (!owner || owner.disabledAt) return reply.code(404).type("text/plain").send("Not Found");

    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendar.id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));

    // ── 允许被 iframe 嵌入(只在 /embed/*,站点其余部分不变)──────
    //
    // 谁可以嵌:管理员在后台配了来源白名单就按白名单,没配则沿用
    // 历史行为「任意站点」。之所以默认不收紧:这个组件是只读日历、
    // 无表单无状态变更,而且会话 cookie 是 SameSite=Lax(跨站 iframe
    // 根本带不上),点击劫持没有可劫持的动作;贸然改默认值只会让
    // 现有用户的嵌入页面一夜之间变白板。想收紧的人配白名单即可。
    //
    // X-Frame-Options 这里是【删除】而不是发 "ALLOWALL":那不是标准
    // 取值,规范要求浏览器忽略非法值,但部分浏览器的处理是按 DENY
    // 对待 —— 等于把自家组件挡死。允许嵌入的正确做法就是不发这个头,
    // 由 CSP frame-ancestors 单独表达策略(它还支持白名单,XFO 不支持)。
    const ancestorList = settings.embedFrameAncestors
      .split(/[\s,]+/)
      .map((o) => o.trim())
      // 只收合法 origin —— 挡住有人往设置里塞 ";" 拼接出别的 CSP 指令
      .filter((o) => /^https?:\/\/[a-z0-9.:*-]+$/i.test(o))
      .slice(0, 20);
    // fail-closed:管理员填了内容但一条都没通过校验(拼错、写成
    // "example.com" 少了协议、或试图注入),按「拒绝嵌入」处理 ——
    // 绝不能因为配置写错就静默放开成任意站点。
    const rawConfigured = settings.embedFrameAncestors.trim().length > 0;
    const frameAncestors = ancestorList.length > 0
      ? ancestorList.join(" ")
      : (rawConfigured ? "'none'" : "*");
    reply.removeHeader("x-frame-options");
    reply.header("Content-Security-Policy",
      "default-src 'self'; " +
      "script-src 'self' 'nonce-" + ((req.raw as unknown as { cspNonce?: string }).cspNonce ?? "") + "'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "font-src 'self' data:; " +
      "form-action 'none'; " +
      "base-uri 'none'; " +
      "object-src 'none'; " +
      "frame-ancestors " + frameAncestors);
    // ⚠️ 不能走 reply.view:@fastify/view 配了全局 layout,会把任何视图
    // 都塞进 layout.ejs 的 <body> 里。embed.ejs 自带完整 <html>(iframe
    // 组件必须是独立文档,不能带站点导航/页脚),套上 layout 后不仅结构
    // 嵌套错误,还因为没传 title 直接 500 —— 也就是说嵌入组件此前一直
    // 是坏的。这里手工渲染模板并原样返回。
    const locale = resolveLocaleFromRequest(req, null, settings.defaultLocale);
    const html = await ejs.renderFile(
      path.join(process.cwd(), "src", "views", "embed.ejs"),
      {
      calendar,
      events: rows.map((e) => ({
        id: e.id,
        summary: e.summary,
        description: e.description,
        location: e.location,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        allDay: e.allDay,
      })),
        publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
        currentLocale: locale,
        t: makeT(locale),
        cspNonce: (req.raw as unknown as { cspNonce?: string }).cspNonce ?? "",
        jsonForScript,
      },
      { async: true },
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
