import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { createSession, loadFullSession } from "../lib/session.js";
import { getProviderBySlug, listEnabledProvidersPublic } from "../lib/sso_providers.js";
import { findUserIdByIdentity, linkIdentity } from "../lib/identities.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  generatePkce,
  randomState,
} from "../lib/sso.js";
import { recordLoginEvent } from "../lib/login_history.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { setThemeCookies } from "../lib/user_theme.js";
import { userIsActive } from "../lib/user_state.js";
import {
  decideEmailClaim,
  evictAccountCredentials,
  provisionAccount,
  type EvictionContext,
  type ProvisionDenial,
  type ProvisionRequest,
  type ProvisionResult,
} from "../lib/account_provisioning.js";
import { tForRequest } from "../lib/i18n.js";

const STATE_COOKIE = "bwc_sso_state";

// Redirect URI used in the OIDC dance. We deliberately use /auth/idp/...
// instead of /auth/sso/... because 宝塔 / 阿里云 / 等 WAF 默认规则把
// "sso" 当成敏感关键字直接 444 拦截 (拦掉 IdP 回调 = SSO 流程整个废掉).
// Keeps the old /auth/sso/* paths registered too so previously-configured
// IdPs that already point to /auth/sso/callback keep working IF the
// user whitelists /auth/sso in their WAF; new providers should use the
// /auth/idp variant.
function redirectUri(): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/idp/callback`;
}

/** Request-scoped translate for route handlers — flash messages, page
 *  titles, error-view copy. Locale comes from `req.locale`, stashed by the
 *  view-locals hook in src/server.ts. See tForRequest in src/lib/i18n.ts. */
function tr(req: FastifyRequest, key: string, vars?: Record<string, string | number>): string {
  return tForRequest(req)(key, vars);
}

// ---------------------------------------------------------------------------
// IdP 说这个邮箱验过了吗
// ---------------------------------------------------------------------------

/**
 * 读 userinfo 的 `email_verified`。
 *
 * 规范(OIDC Core 5.1)写的是布尔,但现实里相当一部分 IdP 把它序列化成字符串
 * "true" —— 早年的 PHP/Java 实现、以及一堆把 claim 当字符串存的网关。所以两种
 * 都要认;不认的话接这类 IdP 的站点会发现所有人都被当成「没验过」。
 *
 * **缺失 = 没验过。** 这是这个函数唯一真正重要的一行:这道判断下游控制的是
 * 「能不能按邮箱接管一个已有账号」,而「字段不在」恰恰说明 IdP 没有对这个邮箱
 * 做任何断言。把缺失当成真,等于让一个什么都没说的 IdP 拥有最高权限。
 *
 * 也不认 "1" / "yes" / 数字 1:没有哪个 IdP 这么发,而每多认一种写法,这道门就
 * 多一条可以被凑出来的路。要加就得先有真实的 IdP 样本。
 */
export function idpEmailVerified(claim: unknown): boolean {
  if (claim === true) return true;
  if (typeof claim === "string") return claim.trim().toLowerCase() === "true";
  return false;
}

// ---------------------------------------------------------------------------
// 登录解析(可测的那一半)
// ---------------------------------------------------------------------------

// 外部依赖走端口,跟 lib/account_provisioning.ts 的 ProvisioningStore 一个写法:
// 线上用下面的 dbSsoStore,行为不变;测试喂假 store,不需要 Postgres,也不用
// 把整个 Fastify 应用拉起来。
export type SsoLoginStore = {
  findUserIdByIdentity(provider: string, subject: string): Promise<string | null>;
  loadUserById(id: string): Promise<schema.User | undefined>;
  findUserByEmail(email: string): Promise<schema.User | undefined>;
  linkIdentity(input: { userId: string; provider: string; subject: string; email: string }): Promise<unknown>;
  provision(req: ProvisionRequest): Promise<ProvisionResult>;
  /**
   * 认领一行**没验过邮箱**的账号时,把它上面既有的登录方式全部作废。
   *
   * 可选,但**缺省不是「跳过」而是走真实现**(见 resolveSsoLogin 里的 ??):
   * 假 store 漏实现它的时候,那条路会当场炸在没有数据库上,而不是安静地把
   * 「凭据作废了吗」这条断言喂成绿的。
   */
  evictCredentials?(userId: string, ctx: EvictionContext): Promise<void>;
};

const dbSsoStore: SsoLoginStore = {
  findUserIdByIdentity: (provider, subject) => findUserIdByIdentity(provider, subject),
  async loadUserById(id) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return u;
  },
  async findUserByEmail(email) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    return u;
  },
  linkIdentity: (input) => linkIdentity(input),
  provision: (input) => provisionAccount(input),
  evictCredentials: (userId, ctx) => evictAccountCredentials(userId, ctx),
};

export type SsoLoginInput = {
  slug: string;
  subject: string;
  /** 已经 trim + 小写过。 */
  email: string;
  /** idpEmailVerified() 的结果,不是原始 claim。 */
  emailVerified: boolean;
  displayName: string | null;
  ctx?: { ip?: string | null; userAgent?: string | null };
};

export type SsoLoginOutcome =
  | { ok: true; user: schema.User; created: boolean }
  | { ok: false; denial: ProvisionDenial };

/**
 * 把一次 SSO 回调解析成一个账号。
 *
 * 顺序,以及为什么是这个顺序:
 *
 * 1. **(provider, subject)** —— 这条绑定是之前某次登录真的建立过的,是这个
 *    IdP 身份和这个账号之间唯一有凭据的关系。不管 email_verified 是什么都认。
 *
 * 2. **按邮箱认领已有账号 —— 判定收口在 decideEmailClaim。**
 *    之前这一步是无条件的:找不到 subject 就拿邮箱去匹配,匹配上就自动绑定。
 *    于是只要站点接了一个允许用户自填邮箱的 IdP(大多数自助注册的 IdP 都允许),
 *    攻击者在那边注册站长的邮箱、点一次 SSO 登录,就直接进了站长的 ByWave
 *    账号 —— 密码、MFA、邮箱验证全部绕过。
 *
 *    上一轮把它收紧成「只在 IdP 说 email_verified 为真时」,但那一刀切得太宽:
 *    user_identities 这张表没有回填,而企业 Keycloak / LDAP / Entra ID 里
 *    email_verified 为假或干脆不发是常态 —— 三个月没登过的老 SSO 用户于是
 *    **一个都进不来**,而且 SSO 开出来的号没有本地密码可以退回去。
 *    现在的口径见 decideEmailClaim:IdP 的背书**或者**「这一行上次就是从这个
 *    IdP 进来的」(ssoProviderSlug),两条凭据认一条;并且认领一行自己没验过
 *    邮箱的账号时,先把它上面所有既有登录方式作废。
 *
 * 3. 还没有账号 → 走建号收口(来源 sso:<slug>)。这里有两件事:
 *    - emailVerified 按 IdP 的真实值落库,不再强行写 true;
 *    - onExistingEmail 在未验证时传 "refuse"。第 2 步之后邮箱撞车只剩并发一种
 *      可能,但这道保险必须在:收口函数的默认是 adopt,而 adopt 正是第 2 步刚
 *      刚拒绝掉的那个动作。默认值将来要是被改动,这条路不能跟着一起破。
 */
export async function resolveSsoLogin(
  input: SsoLoginInput,
  store: SsoLoginStore = dbSsoStore,
): Promise<SsoLoginOutcome> {
  const byIdentityUserId = await store.findUserIdByIdentity(input.slug, input.subject);
  if (byIdentityUserId) {
    const linked = await store.loadUserById(byIdentityUserId);
    // 身份行还在、用户行没了(管理员删号但身份行漏删)→ 不当成命中,往下走建号
    // 判定,而不是把一个 undefined 当成登录成功。
    if (linked) return { ok: true, user: linked, created: false };
  }

  // 邮箱查一次就够,verified 与否都查:该不该认领是 decideEmailClaim 的事,
  // 不是「要不要去查」的事。判定条件散回调用点正是上一轮那一刀切宽的由来。
  const byEmail = await store.findUserByEmail(input.email);
  if (byEmail) {
    const decision = decideEmailClaim({
      row: { emailVerified: byEmail.emailVerified, ssoProviderSlug: byEmail.ssoProviderSlug },
      claimProvider: input.slug,
      provenEmail: input.emailVerified,
    });
    if (decision !== "refuse") {
      if (decision === "adopt_after_eviction") {
        // 「在你证明邮箱之前这个号不算你的」:这一行是别人开的、而且从没验过
        // 邮箱,现在有人证明了邮箱把它领走 —— 原主人手上的密码 / 会话 / 设备 /
        // API 令牌 / 应用专用密码一并作废。
        const evict = store.evictCredentials ?? evictAccountCredentials;
        await evict(byEmail.id, {
          claimedBy: `sso:${input.slug}`,
          ip: input.ctx?.ip ?? null,
          userAgent: input.ctx?.userAgent ?? null,
        });
      }
      // 认领的同时把 subject 绑上:IdP 以后改了邮箱,第 1 步仍然认得出这个人。
      await store.linkIdentity({ userId: byEmail.id, provider: input.slug, subject: input.subject, email: input.email });
      return { ok: true, user: byEmail, created: false };
    }
  }

  const r = await store.provision({
    email: input.email,
    origin: { kind: "sso", slug: input.slug },
    emailVerified: input.emailVerified,
    displayName: input.displayName,
    // **一律 refuse。**
    //
    // 走到这一步说明第 2 步没找到同邮箱的账号,所以这里再撞上一行只剩一种可能:
    // 并发的另一个请求刚刚把它建出来。而那一行**没有过第 2 步的认领判定** ——
    // 让收口函数在这里 adopt 掉,等于给认领开了一条不看 decideEmailClaim 的旁路。
    // 原来这里写的是 `input.emailVerified ? "adopt" : "refuse"`,那条 adopt 正好
    // 把「判定被绕过」这件事从测试里藏了起来:第 2 步整个关掉,登录照样成功。
    //
    // 代价是输掉竞态的那个请求会看到一句「先用原来的方式登录」,重试一次就好 ——
    // 换来的是这条路上只有一份认领判定。
    onExistingEmail: "refuse",
    ctx: input.ctx,
  });
  if (!r.ok) return { ok: false, denial: r.reason };
  await store.linkIdentity({ userId: r.user.id, provider: input.slug, subject: input.subject, email: input.email });
  return { ok: true, user: r.user, created: r.created };
}

/**
 * 登录成功后要往 users 行上刷的那点东西。
 *
 * 只在 IdP 明确断言验证过时才把这个号提升成「已验证」。原来这里是无条件写 true
 * —— 任何一个 IdP 只要肯发一个邮箱,这边的邮箱验证状态就归它说了算。
 *
 * **反过来也不降级**:IdP 说 false 时不动这一列。能走到这里说明账号是按
 * (provider, subject) 认出来的,本来就是他的;而 emailVerified 可能是他当初在本
 * 站点过验证邮件挣来的。拿一个外部 claim 去推翻本站自己验过的事实,只会把人重新
 * 扔回「请先验证邮箱」,而他手上并没有新的验证邮件可点。
 */
export function ssoLoginPatch(
  user: Pick<schema.User, "emailVerified" | "ssoProviderSlug">,
  slug: string,
  idpVerified: boolean,
): Partial<schema.User> {
  const patch: Partial<schema.User> = {};
  if (idpVerified && !user.emailVerified) patch.emailVerified = true;
  if (user.ssoProviderSlug !== slug) patch.ssoProviderSlug = slug;
  return patch;
}

/**
 * 拒绝原因 → 登录页的提示。收口函数只回结构化原因码,文案是这一层的事。
 *
 * email_taken 这条是主角:它的实际含义是「这个邮箱这边有账号,但 IdP 没有证明
 * 它是你的」。所以不能回一句「邮箱已被注册」了事 —— 真正的本人看到那句话会以为
 * 自己没救了。要告诉他走哪条路:先用原来的方式登录,再去设置里把这个 IdP 绑上。
 * 绑过之后走的就是第 1 步的 (provider, subject),跟邮箱验没验过再无关系。
 */
function ssoDenialMessage(req: FastifyRequest, denial: ProvisionDenial): string {
  switch (denial.code) {
    case "email_taken": return tr(req, "flash.sso.linkInSettings");
    case "registration_closed": return tr(req, "flash.register.closed");
    case "invite_required": return tr(req, "errorPage.inviteOnly.message");
    case "invite_invalid": return tr(req, "flash.invite.invalid");
    // 这两句跟网页注册表单被同一道闸门拦下时说的是同一件事,共用同一个键:
    // 同样的处境在两个入口给出两句不同的话,只会让管理员以为是两个毛病。
    case "domain_not_allowed": return tr(req, "flash.register.domainNotAllowed");
    // 配额数字是管理员的闸门,不往登录页上抖。
    case "daily_quota_reached": return tr(req, "flash.register.quotaReached");
    case "invalid_email": return tr(req, "flash.sso.noEmail");
    case "create_failed":
    default: return tr(req, "flash.sso.createFailed");
  }
}

export async function ssoRoutes(app: FastifyInstance) {
  // Legacy entry point (only one Keycloak): pick the first enabled provider,
  // or 404 if SSO isn't enabled. Keeps old "use SSO login" buttons working.
  // Dual-registered on /auth/sso and /auth/idp so the in-app button works
  // even when the WAF blocks the "sso" variant.
  const handleLegacyLogin = async (_req: FastifyRequest, reply: FastifyReply) => {
    const list = await listEnabledProvidersPublic();
    if (list.length === 0) return reply.code(404).type("text/plain").send("SSO not enabled");
    return reply.redirect(`/auth/idp/${encodeURIComponent(list[0]!.slug)}/login`);
  };
  app.get("/auth/sso/login", handleLegacyLogin);
  app.get("/auth/idp/login", handleLegacyLogin);

  const handleProviderLogin = async (req: FastifyRequest<{ Params: { slug: string }; Querystring: { link?: string } }>, reply: FastifyReply) => {
    const slug = req.params.slug;
    const prov = await getProviderBySlug(slug);
    if (!prov || !prov.enabled) return reply.code(404).type("text/plain").send("Provider not found");
    // Link mode: a logged-in user is BINDING this SSO identity to their current
    // account (rather than logging in/switching). Only honored when a session
    // actually exists; the callback re-checks the session as the authority.
    const linkMode = req.query.link === "1" && Boolean(await loadFullSession(req));
    try {
      const state = randomState();
      const nonce = randomState();
      const { verifier, challenge } = generatePkce();
      const cookieValue = Buffer.from(JSON.stringify({ slug, state, nonce, verifier, link: linkMode })).toString("base64url");
      reply.setCookie(STATE_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        path: "/",
        maxAge: 10 * 60,
      });
      const url = await buildAuthorizeUrl({
        providerSlug: slug,
        redirectUri: redirectUri(),
        state,
        nonce,
        codeChallenge: challenge,
      });
      return reply.redirect(url);
    } catch (err) {
      req.log.warn({ err, slug }, "sso_login_start_failed");
      return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.configError", { error: err instanceof Error ? err.message : tr(req, "common.unknownError") })));
    }
  };
  app.get<{ Params: { slug: string }; Querystring: { link?: string } }>("/auth/sso/:slug/login", handleProviderLogin);
  app.get<{ Params: { slug: string }; Querystring: { link?: string } }>("/auth/idp/:slug/login", handleProviderLogin);

  const handleCallback = async (
    req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>,
    reply: FastifyReply,
  ) => {
      if (req.query.error) {
        return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.providerError", { error: String(req.query.error_description || req.query.error) })));
      }

      const cookie = req.cookies[STATE_COOKIE];
      if (!cookie) return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.sessionExpired")));
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      let parsed: { slug: string; state: string; nonce: string; verifier: string; link?: boolean };
      try {
        parsed = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
      } catch {
        return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.stateCorrupt")));
      }

      const prov = await getProviderBySlug(parsed.slug);
      if (!prov || !prov.enabled) {
        return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.providerDisabled")));
      }
      if (!req.query.state || req.query.state !== parsed.state) {
        return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.stateMismatch")));
      }
      if (!req.query.code) {
        return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.noCode")));
      }

      try {
        const tokens = await exchangeCode({
          providerSlug: parsed.slug,
          code: req.query.code,
          redirectUri: redirectUri(),
          codeVerifier: parsed.verifier,
        });
        const info = await fetchUserinfo(parsed.slug, tokens.access_token);
        const email = (info.email ?? "").toLowerCase().trim();
        const subject = (info.sub ?? "").trim();
        if (!email) {
          return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.noEmail")));
        }
        if (!subject) {
          return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.noSub")));
        }

        // ---- Link mode: bind this SSO identity to the CURRENT account. ----
        // The session cookie survives the OIDC round-trip, so re-read it here
        // as the authority (the state cookie only flags intent). We do NOT
        // switch/create accounts in this branch.
        if (parsed.link) {
          const session = await loadFullSession(req);
          if (!session) {
            return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.linkNeedsSignIn")));
          }
          const linked = await linkIdentity({ userId: session.user.id, provider: parsed.slug, subject, email });
          if (!linked.ok) {
            return reply.redirect("/app/settings/security?error=" + encodeURIComponent(tr(req, "flash.sso.alreadyLinkedElsewhere")));
          }
          if (session.user.ssoProviderSlug !== parsed.slug) {
            await db.update(schema.users).set({ ssoProviderSlug: parsed.slug, updatedAt: new Date() }).where(eq(schema.users.id, session.user.id));
          }
          // created=false ⇒ this identity was already the user's own — re-binding
          // yourself is a no-op; say so instead of a misleading "已绑定".
          const msg = linked.created ? tr(req, "flash.sso.linked") : tr(req, "flash.sso.alreadyYours");
          return reply.redirect("/app/settings/security?success=" + encodeURIComponent(msg));
        }

        // ---- Normal login: 见 resolveSsoLogin 的注释 ----
        const idpVerified = idpEmailVerified(info.email_verified);
        const outcome = await resolveSsoLogin({
          slug: parsed.slug,
          subject,
          email,
          emailVerified: idpVerified,
          displayName: info.name || info.preferred_username || null,
          ctx: { ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "") || null },
        });
        if (!outcome.ok) {
          return reply.redirect("/login?error=" + encodeURIComponent(ssoDenialMessage(req, outcome.denial)));
        }
        let user: schema.User = outcome.user;

        // Disabled-account gate: stop BEFORE writing any login event / alert,
        // otherwise a disabled user can keep triggering "you just signed in".
        if (!userIsActive(user)) {
          return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.accountDisabled")));
        }
        // Keep the email-verified flag + last-used provider fresh. 判定见 ssoLoginPatch。
        {
          const patch = ssoLoginPatch(user, parsed.slug, idpVerified);
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = new Date();
            await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
            user = { ...user, ...patch } as schema.User;
          }
        }

        await createSession(reply, user.id, { kind: "sso", slug: parsed.slug });
        setThemeCookies(reply, user.themePalette, user.themeDensity);
        void notifyLoginSuccess(req, user, "sso").catch((err) => req.log.warn({ err }, "login_alert_failed"));
        void recordLoginEvent(req, user.id, "sso").catch((err) => req.log.warn({ err }, "login_event_failed"));
        // 返回到失效前的页面 —— bwc_return_to cookie 写在 /login 入口
        // 或鉴权失败时。SSO 跳转期间 cookie 一直在浏览器里，回来读得到。
        let redirect = "/app";
        const raw = req.cookies["bwc_return_to"];
        if (raw) {
          const unsigned = req.unsignCookie(raw);
          if (unsigned.valid && unsigned.value) {
            const v = unsigned.value;
            if (v.length > 0 && v.length <= 200 &&
                v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") &&
                /^\/(app|admin|web-pair|desktop-pair)(\/|$|\?|#)/.test(v)) {
              redirect = v.split("#")[0] ?? "/app";
            }
          }
          reply.clearCookie("bwc_return_to", { path: "/" });
        }
        return reply.redirect(redirect);
      } catch (err) {
        req.log.warn({ err, slug: parsed.slug }, "sso_callback_failed");
        return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.sso.loginFailed", { error: err instanceof Error ? err.message : tr(req, "common.unknownError") })));
      }
  };
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/sso/callback", handleCallback);
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/idp/callback", handleCallback);
}
