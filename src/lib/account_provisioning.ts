// 建号收口。**全仓库只有这个模块可以往 users 表插行。**
//
// 为什么要收口:在这之前有 5 个入口各自 insert(schema.users),而其中只有网页
// 注册表单那一条检查过注册策略。结果是外部 IdP 那条路在 45 天里建了 30 个号,
// 站点管理员完全不知道这些人是谁 —— 注册开关对它压根无效。
// 这是本仓库处理封禁时学到的同一条教训:判定散在各处,就一定有某一处忘了判。
// 判定只写一份,新入口想建号就只能从这道门过。
//
// 这个模块**不产出任何用户可见文案**,只回结构化原因码。网页要跳转、JSON 要
// 400、IdP 要 403,各自那一层去翻译 —— 翻译混进来的话,收口函数就得知道
// 自己被谁调用,那道门又会开始长出分叉。
//
// 外部依赖全部走 ProvisioningStore 这个端口。线上用下面的 dbProvisioningStore,行为不变;
// 测试喂假 store,不需要 Postgres。

import { randomBytes } from "node:crypto";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword } from "./password.js";
import { getSettings } from "./site_settings.js";
import { consumeInvite, validateInvite, type InviteValidation } from "./signup_invite.js";

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

// 调用方声明自己是哪条路。注意 sso/apple 把各自那个外部标识也带进来了:
// ssoProviderSlug 和 appleSub 必须跟 users 行**在同一条 INSERT 里**落库,
// 不能建完再 UPDATE —— apple_sub 上有唯一索引,分成两步的话两个请求能同时
// 插入成功、第二步才撞,那时账号已经建出来了。
export type SignupOrigin =
  | { kind: "self" }                      // 自己在网页 / JSON 接口注册
  | { kind: "sso"; slug: string }         // 浏览器 SSO 首次登录自动开通
  | { kind: "idp"; client: string }       // 外部 IdP 受信任服务客户端懒建号
  | { kind: "apple"; sub: string }        // Sign in with Apple 首次登录
  | { kind: "admin" };                    // 管理员 / 脚本手工建

export type SignupOriginKind = SignupOrigin["kind"];

/**
 * users.signup_source 的取值。**只有本模块写这一列。**
 *
 * self 和 invite 的分界:调用方一律声明 kind:"self",真的用掉了一张邀请码才
 * 记成 invite。让调用方自己区分的话,它得先知道站点当前是不是 invite 模式,
 * 而那正是收口函数要替它判的事。
 */
export function signupSourceFor(origin: SignupOrigin, usedInvite: boolean): string {
  switch (origin.kind) {
    case "self": return usedInvite ? "invite" : "self";
    case "sso": return `sso:${origin.slug}`;
    case "idp": return `idp:${origin.client}`;
    case "apple": return "apple";
    case "admin": return "admin";
  }
}

// ---------------------------------------------------------------------------
// 原因码
// ---------------------------------------------------------------------------

type InviteFailReason = Extract<InviteValidation, { ok: false }>["reason"];

export type ProvisionDenial =
  | { code: "invalid_email" }
  | { code: "registration_closed" }
  | { code: "invite_required" }
  // 原样透传 signup_invite 的判定原因,调用方那边已经有按这个分支出文案的代码
  // (web/index.ts 的 inviteErrorMsg),别在这里合并成一个 "invite_invalid"。
  | { code: "invite_invalid"; inviteReason: InviteFailReason }
  | { code: "domain_not_allowed"; domain: string }
  | { code: "daily_quota_reached"; quota: number }
  | { code: "email_taken" }
  | { code: "create_failed" };

export type ProvisionResult =
  | { ok: true; user: schema.User; created: boolean; source: string | null; inviteConsumed: boolean }
  | { ok: false; reason: ProvisionDenial };

// ---------------------------------------------------------------------------
// 入参
// ---------------------------------------------------------------------------

export type ProvisionRequest = {
  email: string;
  origin: SignupOrigin;
  /**
   * 邮箱是否真的验证过。**按传入值落库,不在这里强行写 true。**
   * 以前 sso.ts 和 external_idp.ts 都无条件写 true,于是「IdP 说这个邮箱没验过」
   * 这个事实在库里消失了,后面没有任何一层还能知道。
   */
  emailVerified: boolean;
  /**
   * 显示名按原样落库(空 → null)。**这里不做 email 本地部分的回落** ——
   * external_idp 原来有 `displayName || email.split("@")[0] || email` 这个回落,
   * 那是它自己那一层的口径,调用方算好了再传进来,别指望收口函数替它想。
   */
  displayName?: string | null;
  /** 有本地密码的路径(网页/JSON 注册)传进来;不传 = 无密码账号,下面生成 bcrypt 占位串。 */
  passwordHash?: string | null;
  inviteToken?: string | null;
  /**
   * 邮箱已经有账号时怎么办:
   *   adopt  —— 把已有账号交回调用方,created:false(登录类路径:SSO/Apple/IdP 懒建号)
   *   refuse —— 回 email_taken(注册类路径;以及 IdP 没断言 email_verified 的 SSO,见 P4)
   * 默认 adopt,因为「按邮箱认回同一个人」是这些路径的历史行为。
   */
  onExistingEmail?: "adopt" | "refuse";
  /** 只用于配额拒绝那条审计行。 */
  ctx?: { ip?: string | null; userAgent?: string | null };
};

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export type SignupGateSettings = {
  registrationMode: "closed" | "public" | "invite";
  signupDomainAllowlist: string;
  signupDailyQuota: number;
};

export type InsertUserValues = {
  email: string;
  emailVerified: boolean;
  passwordHash: string;
  displayName: string | null;
  signupSource: string;
  ssoProviderSlug: string | null;
  appleSub: string | null;
};

/** 今天这一格配额:窗口起点 + 上限。 */
export type QuotaWindow = { since: Date; max: number };

/**
 * over:true  —— 配额已经满了,这次**什么都没插**。
 * over:false —— 插过了;user 是插入结果,撞唯一索引时 undefined(语义同 insertUser)。
 */
export type QuotaInsert = { over: true } | { over: false; user: schema.User | undefined };

export type ProvisioningStore = {
  loadGateSettings(): Promise<SignupGateSettings>;
  findUserByEmail(email: string): Promise<schema.User | undefined>;
  /** 必须是 onConflictDoNothing 语义:撞唯一索引返回 undefined,不抛。 */
  insertUser(values: InsertUserValues): Promise<schema.User | undefined>;
  /**
   * **配额开着时**走的那条:把「今天建了几个」和 INSERT 绑在同一个事务里,
   * 见下面 dbProvisioningStore 的实现和 QuotaWindow 的注释。
   *
   * 可选,而且**只有喂假 store 的纯逻辑测试可以不实现它** —— 那种 store 背后
   * 没有 Postgres,谈不上并发。生产这份必须有,test/account_claim.test.ts 里
   * 有一条断言钉着 dbProvisioningStore 上这个方法存在,少了会红。
   */
  insertUserWithinQuota?(values: InsertUserValues, window: QuotaWindow): Promise<QuotaInsert>;
  createDefaultCalendar(userId: string): Promise<void>;
  countUsersCreatedSince(since: Date): Promise<number>;
  validateInvite(token: string, email: string): Promise<InviteValidation>;
  consumeInvite(token: string, email: string): Promise<{ ok: boolean }>;
  recordQuotaBlock(entry: {
    email: string;
    source: string;
    quota: number;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void>;
};

export const dbProvisioningStore: ProvisioningStore = {
  async loadGateSettings() {
    const s = await getSettings();
    return {
      registrationMode: s.registrationMode,
      signupDomainAllowlist: s.signupDomainAllowlist,
      signupDailyQuota: s.signupDailyQuota,
    };
  },
  async findUserByEmail(email) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    return u;
  },
  async insertUser(values) {
    // 不带冲突目标的 onConflictDoNothing:users 上有两个唯一索引
    // (email 和 apple_sub),两个都要吃掉,别只盯 email。
    const [created] = await db.insert(schema.users).values(values).onConflictDoNothing().returning();
    return created;
  },
  /**
   * 配额的「数」和「插」必须是**一个不可分割的动作**。
   *
   * 原来是先 count 再 insert 两步:十个请求同时进来,十个都数到 0、十个都插,
   * 「今天最多 1 个」当场变成 10 个。这不是理论上的 —— 建号接口就是会被并发打的。
   *
   * Postgres 上真正成立的做法是拿一把**行锁**把这两句串起来。site_settings 只有
   * id=1 这一行,而且这个函数只在「管理员把配额打开了」时才会被调到 —— 配额
   * 打开的意思本来就是「建号要排队」,拿它当闸门不会拖累关掉配额的站点。
   *
   * 关键在 READ COMMITTED 的语义:事务里**每一句**各取一次快照。B 被 A 的行锁
   * 挡住,等 A 提交后才继续,它后面那句 count 取的是新快照,数得到 A 刚插的行。
   * (把 count 和 INSERT 挤进同一条语句就不成立:一条语句只有一个快照,被锁挡住
   * 也不会重取,B 数到的还是旧数字。)
   */
  async insertUserWithinQuota(values, window) {
    return db.transaction(async (tx) => {
      const gate = await tx
        .select({ id: schema.siteSettings.id })
        .from(schema.siteSettings)
        .where(eq(schema.siteSettings.id, 1))
        .for("update");
      // 锁不到东西 = 这道闸门其实没串起来。宁可整条路炸掉也不要一道看起来在
      // 起作用、实际谁都拦不住的配额 —— 走到这里之前 getSettings() 已经保证
      // 这一行存在(它自己会 bootstrap),真出现只可能是库被人动过。
      if (gate.length === 0) throw new Error("signup quota gate: site_settings row 1 is missing");

      const [row] = await tx
        .select({ n: count() })
        .from(schema.users)
        .where(gte(schema.users.createdAt, window.since));
      if (Number(row?.n ?? 0) >= window.max) return { over: true as const };

      const [created] = await tx.insert(schema.users).values(values).onConflictDoNothing().returning();
      return { over: false as const, user: created };
    });
  },
  async createDefaultCalendar(userId) {
    await db.insert(schema.calendars).values({
      ownerId: userId, name: "My Calendar", color: "#6366f1", timezone: "Asia/Shanghai",
    });
  },
  async countUsersCreatedSince(since) {
    const [row] = await db.select({ n: count() }).from(schema.users).where(gte(schema.users.createdAt, since));
    return Number(row?.n ?? 0);
  },
  validateInvite: (token, email) => validateInvite(token, email),
  consumeInvite: (token, email) => consumeInvite(token, email),
  async recordQuotaBlock(entry) {
    await db.insert(schema.adminAuditLog).values({
      actorUserId: null,
      action: "signup.quota_blocked",
      targetType: "user",
      targetId: entry.email,
      details: { source: entry.source, quota: entry.quota },
      // ip 是 NOT NULL,而懒建号这种场景不一定拿得到请求 IP。
      // 这里必须填占位串 —— 传 null 会在拒绝路径上再炸一次。
      ip: entry.ip ?? "-",
      userAgent: entry.userAgent ?? null,
    });
  },
};

// ---------------------------------------------------------------------------
// 认领已有账号:一份判定,三条路共用
// ---------------------------------------------------------------------------
//
// 「认领」指的是:外部登录(浏览器 SSO / 苹果 / 外部 IdP)拿着一个邮箱走进来,
// 而这边已经有一行同邮箱的账号,于是把那一行当成同一个人交出去。
//
// 上一轮堵的是「**IdP 那边**没验过就不许认领」。这一轮堵的是另一半:
// **被认领的那一行自己有没有验过邮箱**。两边都要看,原因是这条真实复现:
//
//     攻击者拿受害者的邮箱在 /auth/register 开一个号(这条路不验邮箱)
//     受害者之后用苹果登录 → 同一行被打上 apple_sub
//     攻击者用自己那个密码登录 → 还是那一行,他一直在里面
//
// 那一行的 email_verified 是 false,意思正是「**还没有人证明过这个邮箱是他的**」。
// 所以口径写成一句话:**在你证明邮箱之前,这个号不算你的。**谁证明了邮箱,
// 号就归谁,而原来挂在这一行上的所有登录方式当场作废。
//
// 为什么不是「直接拒绝认领」(那是另一个可选修法):拒绝的话,抢注者只要把
// 一个单位所有人的邮箱都注册一遍,这些人就**永远**用不了 SSO —— 而他们从来
// 没有一个本站密码可以「先用原来的方式登录」。把 DoS 的开关交到抢注者手里,
// 比让一个自助注册过的人重设一次密码严重得多;后者手里有邮箱,走找回密码
// 就能回来,前者只能等管理员手工删行。

/**
 * 认领判定的结论。
 *   adopt                把已有账号交出去,什么都不动(常规:密码号首次绑 SSO)
 *   adopt_after_eviction 交出去,但先把这一行上所有既有登录方式作废
 *   refuse               不许认领 —— 调用方回「先用原来的方式登录,再到设置里绑定」
 */
export type EmailClaimDecision = "adopt" | "adopt_after_eviction" | "refuse";

export type EmailClaimInput = {
  /** 被认领的那一行现在的样子。 */
  row: { emailVerified: boolean; ssoProviderSlug: string | null };
  /**
   * 认领者所属的 IdP slug。苹果这类没有 slug 概念的来路传 null ——
   * 传 null 就等于宣告「这一行不可能是我的延续」,判定会按最严的那一支走。
   */
  claimProvider: string | null;
  /**
   * 认领者**证明**了这个邮箱吗(IdP 明确断言 email_verified,不是「字段不在」)。
   * 没证明的时候,他给的邮箱只是一个用户自填的字符串。
   */
  provenEmail: boolean;
};

/**
 * 一次认领该怎么处理。
 *
 * 两条历史凭据在这里交汇:
 *
 * 1. **provenEmail** —— IdP 现在就为这个邮箱背书。
 * 2. **延续关系**(row.ssoProviderSlug === claimProvider)—— 这一行上次就是从
 *    这个 IdP 进来的。这一条不是凑数的:user_identities 这张表 2026-06-17 才建、
 *    **没有回填**,所以「三个月没登过的老 SSO 用户」一行 identity 都没有;而
 *    企业 Keycloak 里管理员手工建的用户默认 emailVerified=Off、LDAP 联邦用户
 *    没开 Trust Email 时也是 false、Entra ID 干脆不发这个 claim。只看第 1 条的话,
 *    这批人**一个都登不进来**,而且 SSO 开出来的号没有本地密码可以退回去。
 *    ssoProviderSlug 记的就是「这个号上次是从哪个 IdP 进来的」,它本身就是一条
 *    凭据 —— 而且抢注者伪造不出来:他走的是自助注册,那条路永远把这一列写成 null。
 *
 * 把邮箱回落**收窄**而不是关掉,说的就是第 2 条。
 */
export function decideEmailClaim(input: EmailClaimInput): EmailClaimDecision {
  const continuation = input.claimProvider !== null && input.row.ssoProviderSlug === input.claimProvider;
  // 既没为这个邮箱背书,这一行也不是他自己那条路的延续 → 凭什么说这是他。
  if (!input.provenEmail && !continuation) return "refuse";
  // 这一行自己验过邮箱 = 已经有人证明过它归谁,认领只是多一种登录方式。
  if (input.row.emailVerified) return "adopt";
  // 同一个 IdP 的延续:这一行本来就是它开的,不作废它自己的东西。
  if (continuation) return "adopt";
  // 剩下的就是抢注的形状:这一行没验过,而证明了邮箱的是另一个人。
  return "adopt_after_eviction";
}

/**
 * 「本站自助注册出来的、而且这一行自己从没证明过这个邮箱」。抢注留下的正是这个形状。
 *
 * 单拎出来是给**不该作废任何凭据**的路径用的(见 external_idp.ts):作废是一次
 * 真人登录才该做的动作,不能让一个后台 API 调用顺手做掉。那些路径只能拒绝。
 *
 * signupSource 为 null 的存量行不算 —— 这一列是后加的、明确不回填,把「不知道」
 * 当成「自助注册」会误伤一整批老账号。
 */
export function isUnprovenSelfSignup(row: { emailVerified: boolean; signupSource: string | null }): boolean {
  if (row.emailVerified) return false;
  return row.signupSource === "self" || row.signupSource === "invite";
}

// ---------------------------------------------------------------------------
// 凭据作废
// ---------------------------------------------------------------------------

export type EvictionContext = {
  /** 谁认领的,写进审计行。形如 "sso:keycloak" / "apple"。 */
  claimedBy: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type EvictionStore = {
  evict(userId: string, newPasswordHash: string, ctx: EvictionContext): Promise<void>;
};

const dbEvictionStore: EvictionStore = {
  async evict(userId, newPasswordHash, ctx) {
    await db.transaction(async (tx) => {
      // 密码换成一个随机的真 bcrypt 哈希(不是哨兵串):原来那个密码谁都不知道了,
      // 而拿它去 compare 的代码路径只会安全地失败。
      //
      // **emailVerified 这一列不在这里动。**它记的是「这个邮箱验没验过」这个
      // 事实,该由认领那一层按自己手上的断言去写(浏览器 SSO 走 ssoLoginPatch、
      // 苹果那条路自己写 true)。作废凭据和认定邮箱是两件事,混在一起的话,
      // 将来多一条不带断言的认领路径就会顺手把这一列抬上去。
      await tx.update(schema.users).set({
        passwordHash: newPasswordHash,
        // 这两列都是「登录方式」:留着就等于留了一把钥匙。
        appleSub: null,
        ssoProviderSlug: null,
        mfaEnabled: false,
        mfaTotpSecret: null,
        mfaPendingSecret: null,
        mfaBackupCodes: null,
        // 抢注者可能刚把这个号锁上(连续输错密码)。锁着的话真正的人进来之后
        // 想设密码再登录会莫名其妙被挡。
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      }).where(eq(schema.users.id, userId));

      // 浏览器会话、App 的刷新令牌、通行密钥、别的 IdP 身份 —— 每一条都能
      // 单独把人送进这个号,所以一条都不能留。
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await tx.delete(schema.devices).where(eq(schema.devices.userId, userId));
      await tx.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, userId));
      await tx.delete(schema.userIdentities).where(eq(schema.userIdentities.userId, userId));
      // 抢注者手上那张还没用的重置链接,点一下就能把密码设回去。
      await tx.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, userId));

      const now = new Date();
      await tx.update(schema.apiTokens).set({ revokedAt: now })
        .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)));
      await tx.update(schema.appPasswords).set({ revokedAt: now })
        .where(and(eq(schema.appPasswords.userId, userId), isNull(schema.appPasswords.revokedAt)));

      // 留一条管理员看得见的记录:这是一次「账号换人」,事后有人来问
      // 「我的密码怎么不管用了」时,后台要能答得上来。
      await tx.insert(schema.adminAuditLog).values({
        actorUserId: null,
        action: "account.unverified_claim_evicted",
        targetType: "user",
        targetId: userId,
        details: { claimedBy: ctx.claimedBy },
        // ip 是 NOT NULL,而这条路不一定拿得到请求 IP。
        ip: ctx.ip ?? "-",
        userAgent: ctx.userAgent ?? null,
      });
    });
  },
};

/**
 * 把一行账号上**所有**既有登录方式作废,然后交给认领者。
 *
 * 只在 decideEmailClaim 回 "adopt_after_eviction" 时调。收口成一个函数是因为
 * 本仓库在封禁那次学过同一条:登录方式散在七张表里,判定写在三处就一定有一处
 * 忘了删,而忘掉的那一把钥匙从外面看不出来。
 */
export async function evictAccountCredentials(
  userId: string,
  ctx: EvictionContext,
  store: EvictionStore = dbEvictionStore,
): Promise<void> {
  const newHash = await hashPassword(randomBytes(32).toString("base64"));
  await store.evict(userId, newHash, ctx);
}

// ---------------------------------------------------------------------------
// 闸门 b:邮箱域名白名单
// ---------------------------------------------------------------------------

/**
 * 名单条目的书写规则(管理员看得见的口径,改这里就要改后台那段说明):
 *
 *   example.com     只匹配 example.com 本身。**子域名不算。**
 *   .example.com    匹配 example.com 及其所有子域名。
 *   *.example.com   同上(这个写法太常见,不认的话管理员会以为自己填了其实没生效)。
 *   @example.com    等同 example.com(粘贴邮箱地址时常带的 @,顺手吃掉)。
 *
 * 为什么默认**不含子域名**:这是一道安全闸门,而且默认是关着的 —— 管理员特地
 * 去填它,填的就是自己公司那个邮箱域。子域名默认算进来的话,只要有人能拿到
 * 任意一个子域名下的邮箱(免费二级域名托管、被接管的老子域),这道门就形同虚设。
 * 反过来「写窄了」的代价只是管理员看到一条拒绝、回去补一行,是能自己发现的。
 * 想放开的人有 `.example.com` 可写,不是没有出路,只是必须是他明确写下来的。
 */
export function emailDomainAllowed(email: string, rawAllowlist: string | null | undefined): boolean {
  const entries = (rawAllowlist ?? "")
    // 分隔口径跟 external_idp.parseClientList 完全一致(逗号 / 空白 / 换行)。
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, ""))
    .filter(Boolean);
  // 空名单 = 不限制。这是默认值,也必须一直是默认值:自建产品升级时迁移自动跑,
  // 默认值带一点限制性的话,升级当天所有注册全死,而管理员没改过任何设置。
  if (entries.length === 0) return true;

  // 取**最后一个** @ 之后的那一段:域名按定义就在这儿。这个函数是导出的
  // (后台要拿它预览名单效果),喂进来的串不保证过了上面那道形状校验。
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!domain) return false;

  for (const raw of entries) {
    const wildcard = raw.startsWith("*.") || raw.startsWith(".");
    const base = raw.replace(/^\*?\./, "");
    if (!base) continue;
    if (domain === base) return true;
    if (wildcard && domain.endsWith(`.${base}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 闸门 c:每日配额
// ---------------------------------------------------------------------------

/**
 * 配额窗口的起点 = **服务器本地时区的今天零点**。
 *
 * 为什么不是 UTC:管理员填「每天最多 10 个」,翻日志也是按自己钟点翻的。用 UTC
 * 的话在东八区就是早上八点重置,他会觉得这个数字在乱跳。夏令时切换那天窗口会
 * 长/短一小时,对一个粗粒度的建号刹车无所谓。
 */
export function startOfQuotaDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// 收口函数
// ---------------------------------------------------------------------------

export async function provisionAccount(
  reqInput: ProvisionRequest,
  store: ProvisioningStore = dbProvisioningStore,
): Promise<ProvisionResult> {
  const email = reqInput.email.trim().toLowerCase();
  // 形状必须是「恰好一个 @,两边都非空,全程无空白」。
  // 卡这么死是因为这道门的输入不全是 zod 校验过的:外部 IdP 那条路的邮箱直接
  // 来自令牌里的 claim。带两个 @ 的串(a@evil.com@corp.com)会让「域名是哪一段」
  // 变成一个可以争论的问题 —— 而域名白名单正是按那一段判的。不收就没得争。
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { ok: false, reason: { code: "invalid_email" } };
  }

  // ---- 已有账号:不是建号,不过闸门 ----------------------------------------
  // 顺序很关键。放到闸门后面的话,管理员一关注册,所有老用户的 SSO / Apple
  // 登录当场全挂 —— 他们并没有在建号,只是在登录。
  const existing = await store.findUserByEmail(email);
  if (existing) {
    if ((reqInput.onExistingEmail ?? "adopt") === "refuse") {
      return { ok: false, reason: { code: "email_taken" } };
    }
    return { ok: true, user: existing, created: false, source: existing.signupSource ?? null, inviteConsumed: false };
  }

  const settings = await store.loadGateSettings();

  // ---- 闸门 a:注册策略 ----------------------------------------------------
  // closed 是「一个都不建」,对所有来源一视同仁 —— 包括 SSO / IdP / Apple。
  // 以前这几条路根本不看这个开关,那正是 30 个号是怎么进来的。
  if (settings.registrationMode === "closed") {
    return { ok: false, reason: { code: "registration_closed" } };
  }

  let usedInvite = false;
  const inviteToken = reqInput.inviteToken?.trim() || null;
  if (settings.registrationMode === "invite") {
    // invite 模式下没码就是不建 —— SSO / IdP / Apple 这些路天生带不出邀请码,
    // 于是它们在这个模式下建不了号。这是故意的:管理员选了「邀请制」,意思
    // 就是「只有我发出去的码能开号」,不是「网页表单要码、别的门随便进」。
    if (!inviteToken) return { ok: false, reason: { code: "invite_required" } };
    const v = await store.validateInvite(inviteToken, email);
    if (!v.ok) return { ok: false, reason: { code: "invite_invalid", inviteReason: v.reason } };
    usedInvite = true;
  }

  const source = signupSourceFor(reqInput.origin, usedInvite);

  // ---- 闸门 b:域名白名单 --------------------------------------------------
  if (!emailDomainAllowed(email, settings.signupDomainAllowlist)) {
    return { ok: false, reason: { code: "domain_not_allowed", domain: email.slice(email.lastIndexOf("@") + 1) } };
  }

  // ---- 闸门 c:每日配额(先粗后细) ----------------------------------------
  //
  // 这里是两层,两层都要:
  //   粗:下面这次 count。它挡掉绝大多数请求,**在烧掉那 250ms 的 bcrypt 之前**
  //       ——「今天满了」的请求不该还替它算一次密码哈希。
  //   细:插入时那个带行锁的事务(insertUserWithinQuota)。并发只能在那儿收住,
  //       这一层的 count 天生穿得过去(十个请求同时数到 0、十个都插)。
  // 只留粗的那层就是原来的 bug;只留细的那层功能上也对,但每一次被拒都要白算
  // 一次 bcrypt。
  const quota = settings.signupDailyQuota;
  // quota <= 0 连数都不数:这个功能默认关着,不该让每一次建号都多打一条 count 查询。
  const quotaWindow: QuotaWindow | null = quota > 0 ? { since: startOfQuotaDay(new Date()), max: quota } : null;

  // 「拒绝要留一条可见记录」:撞配额是管理员自己设的闸门在起作用,他必须
  // 能在后台看到今天挡了谁,否则用户来问「我注册不了」时他两手空空。
  // 策略/域名那两道不写审计:站点一关注册,机器人会把这张表刷爆。
  const quotaBlocked = async (): Promise<ProvisionResult> => {
    await store.recordQuotaBlock({
      email,
      source,
      quota,
      ip: reqInput.ctx?.ip ?? null,
      userAgent: reqInput.ctx?.userAgent ?? null,
    });
    return { ok: false, reason: { code: "daily_quota_reached", quota } };
  };

  if (quotaWindow) {
    const today = await store.countUsersCreatedSince(quotaWindow.since);
    if (today >= quotaWindow.max) return quotaBlocked();
  }

  // ---- 建号 ---------------------------------------------------------------
  // 无密码账号(SSO / Apple / IdP)的 password_hash 是 NOT NULL,存一个真的
  // bcrypt 哈希:随机 ~256 位的散列值,猜不出来,而且哪天有别的代码路径拿它
  // 去 compare 也只会安全地失败。**绝不存非 bcrypt 的哨兵串。**
  const passwordHash = reqInput.passwordHash || (await hashPassword(randomBytes(32).toString("base64")));
  const values: InsertUserValues = {
    email,
    emailVerified: reqInput.emailVerified,
    passwordHash,
    displayName: reqInput.displayName?.trim() || null,
    signupSource: source,
    ssoProviderSlug: reqInput.origin.kind === "sso" ? reqInput.origin.slug : null,
    appleSub: reqInput.origin.kind === "apple" ? reqInput.origin.sub : null,
  };

  let created: schema.User | undefined;
  if (quotaWindow && store.insertUserWithinQuota) {
    const reserved = await store.insertUserWithinQuota(values, quotaWindow);
    // 细的那层说满了 —— 这次是**真的**满了(并发的那几个已经提交在库里)。
    if (reserved.over) return quotaBlocked();
    created = reserved.user;
  } else {
    created = await store.insertUser(values);
  }

  if (!created) {
    // 撞了唯一索引 —— 并发的另一个请求刚把这个号建出来。回读认领,不是错误。
    const raced = await store.findUserByEmail(email);
    if (!raced) {
      // 回读还是空:说明撞的是 apple_sub 而不是 email(同一个 Apple 账号挂到
      // 另一个邮箱上了)。这种情况不能悄悄认领别人的号,交回 create_failed。
      return { ok: false, reason: { code: "create_failed" } };
    }
    if ((reqInput.onExistingEmail ?? "adopt") === "refuse") {
      return { ok: false, reason: { code: "email_taken" } };
    }
    // 输了竞态:邀请码**不消费** —— 号不是我们建的。
    return { ok: true, user: raced, created: false, source: raced.signupSource ?? null, inviteConsumed: false };
  }

  await store.createDefaultCalendar(created.id);

  // 邀请码在账号真的落地之后才消费。反过来的话,注册走到一半跑掉就白烧一张
  // 单次码(这是网页注册那条路踩出来的既有口径,照搬)。
  let inviteConsumed = false;
  if (usedInvite && inviteToken) {
    // 尽力而为:这一步失败时账号已经存在了,再往外抛只会把人卡在一个已经
    // 建好的号上进不去。调用方拿 inviteConsumed:false 去记日志。
    try {
      inviteConsumed = (await store.consumeInvite(inviteToken, email)).ok;
    } catch {
      inviteConsumed = false;
    }
  }

  return { ok: true, user: created, created: true, source, inviteConsumed };
}
