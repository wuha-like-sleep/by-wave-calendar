import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { newSessionId } from "./ids.js";
import { env } from "../env.js";

const COOKIE_NAME = "bwc_sid";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// "Remember me" sessions stick for 30 days.
const SESSION_TTL_MS = 30 * ONE_DAY_MS;
// Transient ("one-time") sessions get a 1-day server-side backstop so
// abandoned rows get pruned, but the browser cookie itself is a session
// cookie (no expires attribute) so most browsers drop it on close. The
// 1-day DB TTL is the safety net for browsers that "restore last session"
// across restarts and for tab/browser variants that hold cookies longer.
const SESSION_TRANSIENT_TTL_MS = 1 * ONE_DAY_MS;

/** 不改变服务端状态的方法——只读 token 只允许这些。 */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"]);

// ---------------------------------------------------------------------------
// IdP 服务客户端：「第一次碰这个账号」的取证去重
// ---------------------------------------------------------------------------
//
// 背景：受信任的 Keycloak 服务令牌可以带 X-Account 操作**任何**账号，是本仓库
// 权限最大的一条认证路径。原来的取证钩子只记写操作，理由写的是「读量大风险低」。
// 但懒建号恰恰发生在读请求上 —— 于是审计表里有一行「建了一个号」，旁边没有任何
// 记录说明当时在访问什么。45 天 30 个号就是在这种静默里攒出来的。
//
// 所以读也要记，但不能每条都记（一个日历客户端一分钟能打几十个 GET）。折中：
// 每个 (客户端, 账号) 组合在一个时间窗内只记第一条。
//
// **「第一次」的确切范围**，这是个真实边界，说清楚：
//   - 范围是**单个 Node 进程的内存**。没有 DB、没有 Redis。
//   - 窗口 1 小时，**滑动式**：记过之后这一对再来，只要距上次不到 1 小时就不记；
//     超过 1 小时的下一条又会记一行。所以一个长期在跑的客户端，对每个账号每小时
//     最多留一行。
//   - 表最多 5000 对，满了按最久没用到的先淘汰（被淘汰的那一对下次会重新记一行）。
//   - **进程重启后表是空的**，于是重启后每一对都会再记一次。这是有意的：重启是
//     正好想要一张新快照的时刻，而「重启后第一次」本身就是有用的取证信息。
//   - pm2 多进程 / 多机部署时，每个进程各有一张表，同一对会在每个进程各留一行。
//     数行数去算「访问了几次」是错的；这张日志回答的是「谁在碰谁」，不是计数器。
const SERVICE_TOUCH_WINDOW_MS = 60 * 60 * 1000;
const SERVICE_TOUCH_MAX_ENTRIES = 5000;
const serviceClientTouches = new Map<string, number>();

/**
 * 返回 true = 这一对是「第一次」，调用方应该记一行取证日志。
 * 有副作用（记下时间戳），所以每个请求最多调一次。
 */
export function noteServiceClientTouch(client: string, accountId: string, now: number = Date.now()): boolean {
  // JSON 数组当 key：客户端 id 里出现分隔符也拼不出跟另一对相同的串。
  const key = JSON.stringify([client, accountId]);
  const last = serviceClientTouches.get(key);
  const fresh = last === undefined || now - last >= SERVICE_TOUCH_WINDOW_MS;
  // delete + set：Map 对已存在的 key 做 set 不会改变它的插入顺序，不先删的话
  // 下面的淘汰就变成「按第一次出现的先后淘汰」，最忙的那一对反而最先被踢掉。
  serviceClientTouches.delete(key);
  serviceClientTouches.set(key, fresh ? now : last!);
  while (serviceClientTouches.size > SERVICE_TOUCH_MAX_ENTRIES) {
    const oldest = serviceClientTouches.keys().next();
    if (oldest.done) break;
    serviceClientTouches.delete(oldest.value);
  }
  return fresh;
}

/** 测试用：把上面那张表清空。 */
export function resetServiceClientTouches(): void {
  serviceClientTouches.clear();
}

/** 只读方法。这里跟 READ_ONLY_METHODS 不共用：那一组是「只读 token 能发什么」，
 *  多了 PROPFIND / REPORT —— CalDAV 的这两个方法确实不改状态，但它们一次能读走
 *  整个日历，正是最该留痕的读。两个集合的用途不同，合并会让其中一边悄悄变错。 */
const FORENSIC_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ServiceClientAccess = {
  client: string;
  account: string | undefined;
  accountId: string | undefined;
  method: string;
  path: string;
  status: number;
};

/**
 * 服务客户端这次访问要不要留一行取证日志，留的话长什么样。返回 null = 不留。
 *
 *   - 写操作：每一条都留（原来就是这样，不动）。
 *   - 读操作：只留这个客户端**第一次**碰这个账号的那一条。
 *
 * 一个请求只出一行：既是写又是首次时，记成 mutation 并带上 firstTouch:true。
 *
 * 有副作用（会更新上面那张去重表），所以每个请求只能调一次。
 */
export function serviceClientForensicLine(
  a: ServiceClientAccess,
): { event: string; line: Record<string, unknown> } | null {
  const isRead = FORENSIC_READ_METHODS.has(a.method);
  // 去重按账号 id，不按邮箱：邮箱是会改的，改一次同一个人就会被当成两个账号重刷一遍。
  // 拿不到 id（理论上不该发生）就当成首次，宁可多记一行也不要漏掉一次跨账号访问。
  const firstTouch = a.accountId ? noteServiceClientTouch(a.client, a.accountId) : true;
  if (isRead && !firstTouch) return null;
  return {
    event: isRead ? "idp_service_first_touch" : "idp_service_mutation",
    line: {
      idpServiceClient: a.client,
      account: a.account,
      accountId: a.accountId,
      method: a.method,
      path: a.path,
      status: a.status,
      firstTouch,
    },
  };
}

/**
 * 这个会话**凭什么**算已经过了二次验证。
 *
 * 以前这里是 `opts.mfaSatisfied?: boolean`,默认 `?? true` —— 也就是
 * 「不说就算过了」。于是 POST /api/auth/login 只要不传(它确实没传),
 * 开了 TOTP 的账号拿账号密码就能换到一个**完整**会话:网页、后台、API
 * 全放行,连 forceAdminMfa 也拦不住 —— 它信的是会话行上这个 flag。
 * 而读取侧(loadSession :221)只读这个 flag、不当场重算,签发时写错了
 * 永远救不回来。签发点的默认值是开着的,这是这个洞的全部。
 *
 * 现在换成必填的判别联合,且 mfaSatisfied 由 createSession **自己回读
 * users 行算出来**,调用方没有机会声称自己过了。新入口想拿到一个
 * 「已验证」的会话,只能显式说出自己凭的是哪个因子 —— 而那一行会被人看见。
 *
 * 形状对齐 src/lib/account_provisioning.ts(全仓库只有那一个模块能往
 * users 表插行)。
 */
export type SessionFactor =
  /** 只验了密码。开了二次验证的账号拿到的是**半登录**会话,
   *  必须再过 /login/mfa 才会被 loadSession 放行。 */
  | { kind: "password" }
  /** 当场过了 TOTP 或备用码。 */
  | { kind: "totp" }
  /** passkey —— 本身就是「你有的东西 + 你验过的」,不再要 TOTP。 */
  | { kind: "passkey" }
  /** 外部身份源登录。认证是对方做的,本站不再要 TOTP。 */
  | { kind: "sso"; slug: string }
  /** 上游流程已经验过,这里只是把结果换成浏览器会话。
   *  why 必填且是给人看的:把「上游」是谁写清楚。这类调用点最容易被
   *  后来的人照抄到一个上游其实没验过的地方,而那正是这个洞的复发形状。 */
  | { kind: "delegated"; why: string };

export async function createSession(
  reply: FastifyReply,
  userId: string,
  factor: SessionFactor,
  opts: { rememberMe?: boolean } = {},
): Promise<string> {
  // 「过没过二次验证」在这里算,不接受调用方的说法。
  let mfaSatisfied: boolean;
  if (factor.kind === "password") {
    const [u] = await db
      .select({ mfaEnabled: schema.users.mfaEnabled })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    // 查不到用户就当作「开着二次验证」—— 出错时往严的那边倒。
    mfaSatisfied = u ? !u.mfaEnabled : false;
  } else {
    mfaSatisfied = true;
  }
  const id = newSessionId();
  // Default rememberMe=true preserves the pre-checkbox behavior for all
  // call sites we haven't audited (SSO, register, native-bridge, etc.).
  // Web /login form passes false when the user leaves the box unchecked.
  const rememberMe = opts.rememberMe ?? true;
  const ttl = rememberMe ? SESSION_TTL_MS : SESSION_TRANSIENT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await db.insert(schema.sessions).values({
    id,
    userId,
    expiresAt,
    mfaSatisfied,
  });
  // Cookie shape:
  //   rememberMe=true  → persistent cookie with expires=<30d>
  //   rememberMe=false → session cookie (no expires/maxAge), deleted on
  //                      browser close per the cookie spec. We still
  //                      flag httpOnly + secure + sameSite=lax + signed.
  const cookieOpts: Parameters<FastifyReply["setCookie"]>[2] = {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    signed: true,
  };
  if (rememberMe) cookieOpts.expires = expiresAt;
  reply.setCookie(COOKIE_NAME, id, cookieOpts);
  return id;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[COOKIE_NAME];
  if (raw) {
    const unsigned = req.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) {
      await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    }
  }
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function destroyAllUserSessions(userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export async function markSessionMfaSatisfied(req: FastifyRequest): Promise<void> {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return;
  await db
    .update(schema.sessions)
    .set({ mfaSatisfied: true })
    .where(eq(schema.sessions.id, unsigned.value));
}

export type LoadedSession = {
  user: schema.User;
  sessionId: string;
  mfaSatisfied: boolean;
};

export async function loadSession(req: FastifyRequest): Promise<LoadedSession | null> {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const rows = await db
    .select({
      user: schema.users,
      expiresAt: schema.sessions.expiresAt,
      mfaSatisfied: schema.sessions.mfaSatisfied,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, unsigned.value))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    return null;
  }
  // Suspended account: drop the session entirely so the admin's "stop this
  // user" intent is immediate even for already-logged-in tabs.
  if (row.user.disabledAt) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    return null;
  }
  return { user: row.user, sessionId: unsigned.value, mfaSatisfied: row.mfaSatisfied };
}

/**
 * 完整会话。**半登录一律当作没登录。**
 *
 * loadSession 故意不查二次验证 —— /login/mfa 那一页自己就得先读到那个
 * 半登录会话才能让人补验证码。代价是:除了 MFA 流程本身之外,任何地方
 * 直接用 loadSession 都等于「密码对了就放行」。
 *
 * 实际踩到的三条(都是持久化后门,受害者改密码也清不掉):
 *   · 半登录状态下能给账号注册一个新 passkey → 之后永远免密登录;
 *   · 能删掉受害者已有的 passkey;
 *   · 能替受害者点掉一次 OAuth 授权,把 token 交出去。
 * 也就是说,就算攻击者停在 /login/mfa 那一页,他也已经能做成事了。
 *
 * 需要「这个人此刻是完整登录状态」的地方一律用这个。
 * 还要用裸 loadSession 的只有 MFA 流程本身 —— test/no_half_session_escalation.test.ts
 * 守着这条,新加的用法必须显式进白名单。
 */
export async function loadFullSession(req: FastifyRequest): Promise<LoadedSession | null> {
  const s = await loadSession(req);
  if (!s) return null;
  if (s.user.mfaEnabled && !s.mfaSatisfied) return null;
  return s;
}

export async function loadUserFromRequest(req: FastifyRequest): Promise<schema.User | null> {
  const s = await loadSession(req);
  if (!s) return null;
  if (s.user.mfaEnabled && !s.mfaSatisfied) return null;
  return s.user;
}

/** 路由能声明的 scope 名。写成联合类型而不是 string:写错一个字符
 *  (比如 "read:event")会**静默变成拒绝** —— 因为判据是「granted 里有没有
 *  这个值」,而没有任何值等于 "read:event"。类型收紧之后编译期就红。 */
export type OAuthScopeName = "read:events" | "write:events" | "read:profile";

declare module "fastify" {
  interface FastifyRequest {
    user?: schema.User;
  }
  interface FastifyContextConfig {
    /**
     * 这条路由对「第三方拿 OAuth token 来调」的态度。**必须显式声明。**
     *
     * 不声明 = 拒绝。新加的路由天生对第三方是关着的 —— 这个方向是故意的:
     * 忘了声明的后果是「第三方用不了」(有人会来报),而不是「第三方全都能用」
     * (没人会发现)。
     *
     * 取值是 OAUTH_SCOPES 里的键,或者 "deny" / "any"。
     *
     * "any" 用在「这个 token 是谁的」这类身份端点上:只要 token 有效就放行,
     * 但**返回什么由 scope 决定**(个人信息要 read:profile)。这是 OIDC 的
     * 常规做法,也是必须的 —— 授权页默认只勾 read:events、库里 allowed_scopes
     * 的默认值也是 ["read:events"],把身份端点整个锁在 read:profile 后面
     * 会让**所有存量集成**换完 token 的第一步就 403,而且没有迁移路径:
     * 已签发 token 里的 scope 是写死在库里的那份,改不了。
     *
     * "deny" 用在那些**任何**第三方
     * 授权都不该碰的东西上:改密码、删账号、两步验证、设备增删、以及两条
     * 能把 token 换成更高权限的路(/auth/web-session 换浏览器会话、
     * /devices/*-pair-approve 换长期设备凭据)。
     *
     * 只影响 authVia === "oauth" 的流量。会话 cookie、设备 token、
     * bwc_ API token 走各自的判定,不看这个字段。
     */
    oauthScope?: OAuthScopeName | "deny" | "any";
  }
}

/** 第三方拿 OAuth token 调这条路由,允许吗。
 *
 *  判断必须留在「刚认出 scope 的那一行」旁边,**不能写成 preHandler** ——
 *  隔壁 api_token 那条判断就是因为写成钩子而失效过:authVia / oauthScopes
 *  是 handler 阶段才写进 request 的,钩子读到的永远是 undefined,
 *  于是判断永远不成立,只读 token 能建能删,后台还显示着「只读」。
 *  实测过 GET 200 / POST 201。放在这里,阶段顺序就无从出错。 */
function oauthScopeAllows(req: FastifyRequest, granted: string[]): boolean {
  const declared = (req.routeOptions?.config as { oauthScope?: string } | undefined)?.oauthScope;
  // 没声明 → 拒绝。见 oauthScope 的注释。
  if (!declared || declared === "deny") return false;
  // 身份端点:token 有效即可进门,个人信息在 handler 里按 scope 裁。
  if (declared === "any") return true;
  // 数组元素全等,不是子串匹配 —— 否则 "read:events" 会被
  // "read:events.evil" 这种伪造值命中。
  return granted.includes(declared);
}

/**
 * 认证当前请求。
 *
 * 不变式：返回 null **当且仅当**本函数已经把响应发出去了。调用方必须立刻退出：
 *
 *     const user = await requireUserOrSend(req, reply);
 *     if (!user) return reply;
 *
 * 两条禁令，都是拿线上事故换来的：
 *
 * 1. 绝不新增「返回 null 但没发响应」的分支 —— 请求会永远挂住。
 * 2. 绝不恢复「先 send 再 throw」的写法。异常到达错误处理器时字节已经在线上，
 *    Fastify 的 fallbackErrorHandler 会再 writeHead 一次，而那个重试没有包
 *    try/catch，异常从一条没人接的 promise 链里逃出去 → 未捕获异常 → 进程退出。
 *    一个未认证的 GET /api/calendars 就能打死服务器，2026-08 和 2026-09 各发生
 *    过一次。名字里的 OrSend 就是为了让调用方一眼看见「它可能已经回过话了」。
 *
 * 同形状的生产范式见 lib/caldav_auth.ts 的 send401()。
 */
export async function requireUserOrSend(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<schema.User | null> {
  if (req.user) return req.user;

  // 1) Bearer token (third-party API integration). Only honored when admin
  //    has enabled the API feature in /admin/api. Successful auth bypasses
  //    CSRF since the caller isn't a browser running with our cookies.
  //
  //    Two token formats are accepted:
  //      bwc_*  — admin-issued API token (long-lived, full account scope)
  //      bwo_*  — OAuth 2.0 access token (user-granted, scope-restricted)
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const { db, schema: s } = await import("../db/client.js");
    const { eq } = await import("drizzle-orm");

    // Try OAuth access token first (cheap looksLike check).
    const { looksLikeOAuthToken, verifyOAuthToken, touchOAuthToken } = await import("./oauth_server.js");
    if (looksLikeOAuthToken(token)) {
      const verified = await verifyOAuthToken(token, "api");
      if (verified) {
        const [u] = await db.select().from(s.users).where(eq(s.users.id, verified.userId)).limit(1);
        if (u) {
          // **scope 在这里被执行。** 在此之前它只被「记录」和「展示」:
          // 授权页把 scope 列给用户看、userinfo 把 scope 回显给客户端,
          // 而全仓库没有一个地方拿它做过判断。后果是勾「只读日历」的第三方
          // 能建能改能删事件、能删整本日历,还能走两条路把 token 换成
          // 完整账号控制权 —— 而用户撤销授权也收不回换出去的那些。
          if (!oauthScopeAllows(req, verified.scopes)) {
            reply.code(403).send({
              error: "insufficient_scope",
              // 照实说缺哪个,方便第三方开发者自查;不泄露用户数据。
              message: "这个授权的权限范围不包含此操作",
            });
            return null;
          }
          req.user = u;
          void touchOAuthToken(verified.tokenId).catch(() => undefined);
          (req as unknown as { authVia: string; oauthScopes: string[] }).authVia = "oauth";
          (req as unknown as { oauthScopes: string[] }).oauthScopes = verified.scopes;
          return u;
        }
      }
      reply.code(401).send({ error: "invalid_token" });
      return null;
    }

    const { looksLikeApiToken, verifyApiToken, touchApiToken } = await import("./api_token.js");
    if (looksLikeApiToken(token)) {
      const verified = await verifyApiToken(token);
      if (verified) {
        const [u] = await db.select().from(s.users).where(eq(s.users.id, verified.userId)).limit(1);
        if (u) {
          // 只读 token 不许写。**这道判断必须放在这里**——它曾经写成一个
          // preHandler 钩子，而 authVia 是下面这一行、也就是 handler 阶段才写进
          // request 的：钩子读的时候永远是 undefined，判断永远不成立，于是
          // scope=read 的 token 能建、能改、能删日历和事件，后台还显示着「只读」。
          // 实测过：GET 200 / POST 201。放在知道 scope 的这一行旁边，
          // 阶段顺序就无从出错。
          if (verified.scope === "read" && !READ_ONLY_METHODS.has(req.method)) {
            reply.code(403).send({ error: "token_is_read_only" });
            return null;
          }
          req.user = u;
          void touchApiToken(verified.tokenId, req.ip).catch(() => undefined);
          // Tag the request so downstream handlers can tell session vs API.
          (req as unknown as { authVia: string }).authVia = "api_token:" + verified.scope;
          return u;
        }
      }
      reply.code(401).send({ error: "invalid_token" });
      return null;
    }

    // External IdP (Keycloak) access token — ByWave as OAuth resource server.
    // Keycloak access tokens are RS256 JWTs that also start with "eyJ", so they
    // match the device-token regex below; we MUST resolve them here first.
    // resolveExternalIdpUser returns matched:false unless the token's `iss`
    // equals a configured SSO provider issuer, so our own device JWTs fall
    // straight through to the device path.
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      const { resolveExternalIdpUser } = await import("./external_idp.js");
      const res = await resolveExternalIdpUser(token, req);
      if (res.matched) {
        if (res.user) {
          req.user = res.user;
          (req as unknown as { authVia: string }).authVia = "idp:" + res.provider;
          // Tag service-client (cross-account) access so the onResponse hook can
          // log it for forensics — this is the most powerful auth path. 账号 id
          // 也带上：取证日志按 (客户端, 账号) 去重，而邮箱是会改的，改一次同一个
          // 人就会被当成两个账号重新刷一遍。
          if (res.serviceClient) {
            const tagged = req as unknown as { idpServiceClient?: string; idpActedAs?: string; idpActedAsId?: string };
            tagged.idpServiceClient = res.serviceClient;
            tagged.idpActedAs = res.user.email;
            tagged.idpActedAsId = res.user.id;
          }
          // Auto-provisioning a real account is significant + infrequent →
          // record it in the admin audit log (not just server logs).
          if (res.provisioned) {
            const { audit } = await import("./audit.js");
            void audit(req, res.user.id, "idp.account_provisioned", {
              targetType: "user", targetId: res.user.id,
              details: {
                client: res.serviceClient,
                email: res.user.email,
                // 建号是**顺手**发生的：某个请求进来，账号不存在，于是建一个。
                // 只记 client+email 的话，管理员在后台点开这条只能看到「有人被建出来了」，
                // 看不到当时在干什么。方法+路径补上之后，这条审计行自己就能回答
                // 「谁、在访问什么的时候、顺手建的」。
                // 路径要去掉 query：那上面挂着搜索词、令牌之类不该进审计表的东西。
                method: req.method,
                path: String(req.url ?? "").split("?")[0],
                // 来源标记跟 users.signup_source 是同一列的值，后台按来源筛选时
                // 这条日志和用户列表对得上。null = 存量行，不是 self。
                signupSource: res.user.signupSource ?? null,
              },
            }).catch(() => undefined);
          }
          return res.user;
        }
        reply.code(res.code).send({ error: res.error });
        return null;
      }
      // matched:false → not one of our IdPs; fall through to device-token path.
    }

    // Device access token (JWT, HS256 — issued via /api/v1/devices/pair-claim
    // or /api/v1/auth/refresh). Used by native iOS / Android / desktop apps.
    // The token's `did` claim points to a `devices` row — if that row was
    // revoked we reject regardless of signature/expiry, so admin revokes
    // take effect within 1 hour (the JWT TTL) at worst.
    //
    // Also gated by site_settings.appsEnabled: when admin turns off the
    // APP feature, even valid+unexpired JWTs stop working immediately.
    const { looksLikeAccessToken, verifyAccessToken } = await import("./device_tokens.js");
    if (looksLikeAccessToken(token)) {
      const { getSettings } = await import("./site_settings.js");
      const settings = await getSettings();
      if (!settings.appsEnabled) {
        reply.code(403).send({ error: "apps_disabled" });
        return null;
      }
      const payload = verifyAccessToken(token);
      if (payload) {
        const { loadDeviceById } = await import("./devices.js");
        const device = await loadDeviceById(payload.did);
        if (device && device.userId === payload.sub) {
          const [u] = await db.select().from(s.users).where(eq(s.users.id, payload.sub)).limit(1);
          const { userIsActive } = await import("./user_state.js");
          if (u && userIsActive(u)) {
            req.user = u;
            (req as unknown as { authVia: string; deviceId: string }).authVia = "device:" + device.kind;
            (req as unknown as { deviceId: string }).deviceId = device.id;
            return u;
          }
        }
      }
      reply.code(401).send({ error: "invalid_token" });
      return null;
    }
  }

  // 2) Session cookie (normal browser flow).
  const user = await loadUserFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  req.user = user;
  return user;
}
