import "dotenv/config";
import { isIP } from "node:net";
import { z } from "zod";

const boolFlag = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((v) => (typeof v === "boolean" ? v : ["true", "1", "yes"].includes(v)));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  // Apple Push Notification Service (optional). When APNS_KEY_ID is
  // blank, all push attempts no-op and the server logs once at boot.
  // Sandbox vs production is auto-selected by APNS_PRODUCTION.
  //   APNS_KEY_PATH = absolute path to the .p8 key file from Apple
  //     Developer Console → Keys → "+" → Apple Push Notifications service
  //   APNS_KEY_ID   = 10-char ID shown next to the key in the console
  //   APNS_TEAM_ID  = 10-char team ID from your Apple Developer membership
  //   APNS_BUNDLE_ID = e.g. cn.bywave.calendar (matches the iOS app)
  APNS_KEY_PATH: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRODUCTION: boolFlag.default(false),

  // Sign in with Apple (#67). Comma-separated list of accepted `aud`
  // values for the Apple identity token. For the native iOS app this is
  // the app's BUNDLE ID (e.g. cn.bywave.calendar); for web SIWA it's the
  // Service ID. List both if you support both. When EMPTY, the server's
  // /api/v1/auth/apple endpoint refuses all requests (feature off) — set
  // this only after configuring "Sign in with Apple" in Apple Developer.
  // Falls back to APNS_BUNDLE_ID if that's set and this isn't.
  SIWA_CLIENT_IDS: z.string().optional(),

  // PG connection pool max. Default 20 covers a typical 1-process pm2
  // deployment: reminders cron + per-request connections + CalDAV burst
  // syncs can otherwise queue behind the prior 10-connection limit and
  // make every endpoint feel slow during peak. Bump to 40+ if you put
  // multiple users on the same calendar via heavy CalDAV / API traffic.
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  REGISTRATION_OPEN: boolFlag.default(true),
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),

  // SSRF guard escape hatch. Outbound fetches of *user-supplied* URLs (ICS
  // subscriptions, one-shot URL imports, and — defense-in-depth — outbound
  // webhooks) are blocked from reaching private / loopback / link-local /
  // reserved IP ranges by default. Self-hosters who legitimately need to
  // pull an ICS feed from an internal host (e.g. an intranet calendar) can
  // set this to true to opt out of the IP-range block. Protocol (http/https
  // only) and embedded-credential checks still apply. Leave false unless you
  // know you need it — this is the SSRF blast-radius control.
  ICS_ALLOW_PRIVATE_NETWORK: boolFlag.default(false),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  // HTTPS direct-listen (no nginx reverse proxy).
  USE_HTTPS: boolFlag.default(false),
  HTTPS_PORT: z.coerce.number().int().positive().default(443),
  HTTP_REDIRECT_PORT: z.coerce.number().int().positive().default(80),
  HTTPS_CERT_PATH: z.string().optional(),
  HTTPS_KEY_PATH: z.string().optional(),

  // SMTP / mailer. Required for register email verification + login alerts.
  // If SMTP_HOST is blank, mailer is disabled and email-dependent features fall back
  // to printing the verification code to the server logs (dev only).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: boolFlag.default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default("ByWave-Calendar"),

  // 中国大陆 ICP 备案号 —— 空就不显示，本项目部署到 lz-ss.com 时填写。
  ICP_NUMBER: z.string().optional(),
  ICP_URL: z.string().default("https://beian.miit.gov.cn/"),

  // 站点名 + 默认 logo URL（管理员上传后会被覆盖）
  SITE_NAME: z.string().default("ByWave-Calendar"),

  // ---- 反向代理信任（决定 req.ip 是谁）----
  //
  // req.ip 不只是一条日志字段。全站限流的 key、登录/注册/验证邮件重发的限流、
  // 网页注册的人机验证、审计日志的 ip 列、登录历史的 ip 列，全部取自它。
  // 所以「谁有资格告诉我们访客地址」必须是配置出来的，不能默认全信。
  //
  // 取值形式（逗号分隔，大小写不敏感）：
  //   loopback      本机回环 127.0.0.1 / ::1 —— 宝塔 nginx 反代到
  //                 http://127.0.0.1:3000 就是这一类，**默认值**
  //   linklocal     169.254.0.0/16、fe80::/10
  //   uniquelocal   10/8、172.16/12、192.168/16、fc00::/7（容器网桥、内网网关）
  //   具体地址或网段  203.0.113.7、10.8.0.0/24、2400:cb00::/32
  //   off/false/none  谁都不信，req.ip 永远是 TCP 对端地址（Node 直接监听
  //                 443 不过 nginx 时用这个最干净）
  //
  // 举例：
  //   TRUST_PROXY=loopback                      本机 nginx（默认，绝大多数部署）
  //   TRUST_PROXY=off                           USE_HTTPS=true 直接监听、没有反代
  //   TRUST_PROXY=loopback,173.245.48.0/20      本机 nginx 前面还套了一层 CDN
  //   TRUST_PROXY=uniquelocal                   nginx 和 Node 在不同容器里
  //
  // 为什么默认是 loopback 而不是 true：true 的含义是「X-Forwarded-For 链上
  // 每一跳都可信」，于是 req.ip 取链条**最左边**那一项 —— 而最左边那一项是
  // 客户端自己写进请求头的。实测（本仓库同版本 fastify + rate-limit，max=3）：
  // 每次换一个伪造的 X-Forwarded-For 连打 12 次，一次都没被挡下来。
  TRUST_PROXY: z
    .string()
    .trim()
    .default("loopback")
    .superRefine((raw, ctx) => {
      const err = trustProxyConfigError(raw);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }),
});

// ---------------------------------------------------------------------------
// 反向代理信任：解析 / 校验 / 自检
// ---------------------------------------------------------------------------

/** Fastify 的 trustProxy 取值：false = 谁都不信；字符串数组 = 只信这些地址。 */
export type TrustProxyOption = false | string[];

const TRUST_PROXY_NAMED = new Set(["loopback", "linklocal", "uniquelocal"]);
const TRUST_PROXY_OFF = new Set(["off", "false", "no", "none", "disable", "disabled"]);
/** 这些值听起来像「全信」，但全信正是要修的洞，所以一律拒绝启动。 */
const TRUST_PROXY_ALL = new Set(["true", "yes", "all", "*", "any"]);

/** 单项是否合法：命名段、IP，或 IP/前缀长度、IP/子网掩码。 */
function isTrustProxyEntry(entry: string): boolean {
  const t = entry.trim();
  if (t === "") return false;
  if (TRUST_PROXY_NAMED.has(t.toLowerCase())) return true;
  const slash = t.lastIndexOf("/");
  if (slash === -1) return isIP(t) !== 0;
  const family = isIP(t.slice(0, slash));
  if (family === 0) return false;
  const suffix = t.slice(slash + 1);
  // 子网掩码写法 10.0.0.0/255.0.0.0（proxy-addr 认这种）
  if (isIP(suffix) === 4) return family === 4;
  if (!/^\d{1,3}$/.test(suffix)) return false;
  const bits = Number(suffix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

/**
 * 校验 TRUST_PROXY，返回人能看懂的错误原文；合法返回 null。
 *
 * 两类值被刻意拒绝，理由都是「配了也不会按你以为的方式生效」：
 *  - true / all：无条件信任，等于把 req.ip 的决定权交给客户端。
 *  - 纯数字（跳数）：fastify 5 自带的 @fastify/proxy-addr 对数字型
 *    trustProxy 是 fail-closed 的（getTrustProxyFn 里 `typeof tp === 'number'`
 *    直接 `return false`，注释写明「跳数无法校验直连对端」）。实测
 *    trustProxy: 1 配合 X-Forwarded-For: "9.9.9.9, 203.0.113.7"，
 *    req.ip 拿到的是 127.0.0.1 —— 也就是所有访客会被记成同一个地址、
 *    共用同一个限流桶。与其静默退化，不如启动就报错。
 */
export function trustProxyConfigError(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null; // 走默认值
  const lower = s.toLowerCase();
  if (TRUST_PROXY_OFF.has(lower) || TRUST_PROXY_NAMED.has(lower)) return null;
  if (TRUST_PROXY_ALL.has(lower)) {
    return `TRUST_PROXY=${s} 表示无条件信任 X-Forwarded-For，任何客户端都能自己指定自己的来访地址（限流、审计日志、人机验证全部失效）。请改成 loopback（本机 nginx 反代，最常见）、具体的代理地址/网段，或 off（没有反代）。`;
  }
  if (/^\d+$/.test(s)) {
    return `TRUST_PROXY=${s} 是跳数写法，本项目不支持：fastify 5 对跳数型信任是 fail-closed 的，配了之后 req.ip 会退化成 127.0.0.1，所有访客共用一个限流桶。请改成填代理自己的地址/网段，例如 loopback（本机 nginx）或 10.8.0.0/24。`;
  }
  const entries = s.split(",").map((x) => x.trim()).filter((x) => x !== "");
  // /0 这种前缀长度覆盖整个地址空间，写法上合法但含义就是「全信」。
  // 而且 proxy-addr 自己也不收 0.0.0.0/0（抛 "invalid range on address"），
  // 放过去的结果是进程起不来 —— 不如在这里把话说明白。
  const wideOpen = entries.filter((x) => /\/(0|0\.0\.0\.0)$/.test(x));
  if (wideOpen.length > 0) {
    return `TRUST_PROXY 里的 ${wideOpen.join("、")} 覆盖了整个地址空间，等于无条件信任 X-Forwarded-For。请只填真正属于你自己那台反向代理的地址/网段。`;
  }
  const bad = entries.filter((x) => !isTrustProxyEntry(x));
  if (bad.length > 0) {
    return `TRUST_PROXY 里这些项不是合法的地址/网段：${bad.join("、")}。可用值：loopback / linklocal / uniquelocal / 具体 IP / CIDR（如 10.8.0.0/24）/ off。`;
  }
  return null;
}

/** 把 TRUST_PROXY 文本翻译成 Fastify 的 trustProxy 取值。 */
export function parseTrustProxy(raw: string | undefined): TrustProxyOption {
  const s = (raw ?? "").trim();
  if (s === "") return ["loopback"];
  if (TRUST_PROXY_OFF.has(s.toLowerCase())) return false;
  const list = s.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length > 0 ? list : ["loopback"];
}

/**
 * 部署形态自检。
 *
 * 配错了要能被发现，而不是静默退化 —— 这里最贵的一种错是「代理在，但它那一跳
 * 不在信任名单里」（nginx 和 Node 不在同一台机器/同一个容器网段）。这种情况下
 * req.ip 会恒等于代理自己的地址：全站限流把所有访客塞进同一个桶（用户看到的是
 * 莫名其妙的 429），审计日志的 ip 列全是同一行字（站长正是拿这一列判断谁在建号）。
 * 它不报错、不抛异常，只是所有数字都对不上。
 *
 * 判据刻意做成「需要证据」而不是「一看到回环就喊」：
 *   proxy_header_ignored —— 一个采样窗口内所有带 X-Forwarded-For 的请求，req.ip
 *     始终是同一个地址，而链条最右端（代理写进去的那一项）出现过 ≥2 个不同值。
 *     配置正确时 req.ip 就等于最右端那一项，会跟着访客变，这条永远不会成立。
 *   proxy_header_missing —— 一个采样窗口内一条 X-Forwarded-For 都没有，而所有
 *     请求都来自回环。要么前面有东西但没转发真实地址，要么这台机器只有本机在访问。
 *
 * 不刷屏靠两层：满一个采样窗口（默认 200 条）才判一次，判出来还要过冷却
 * （默认 1 小时）。也就是每种问题最多一小时一行。
 */
export type ProxyShapeIssue = "proxy_header_ignored" | "proxy_header_missing";

export interface ProxyShapeReport {
  issue: ProxyShapeIssue;
  message: string;
  /** 窗口里恒定不变的那个 req.ip。 */
  observedIp: string;
}

export interface ProxyShapeWatcher {
  /** 每个请求调一次；需要记一行日志时返回报告，否则返回 null。 */
  note(input: { ip: string; forwardedFor?: string | string[] }, now?: number): ProxyShapeReport | null;
}

/** X-Forwarded-For 最右端那一项 —— 也就是直连对端写进去的那一跳。 */
function rightmostForwarded(raw: string): string {
  const comma = raw.lastIndexOf(",");
  return (comma === -1 ? raw : raw.slice(comma + 1)).trim();
}

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function createProxyShapeWatcher(
  opts: { sample?: number; cooldownMs?: number } = {},
): ProxyShapeWatcher {
  const sample = opts.sample ?? 200;
  const cooldownMs = opts.cooldownMs ?? 60 * 60 * 1000;

  let total = 0;
  let withHeader = 0;
  let constantIp: string | null = null;
  let ipVaried = false;
  const rightmostSeen = new Set<string>();
  const lastWarnAt = new Map<ProxyShapeIssue, number>();

  function reset(): void {
    total = 0;
    withHeader = 0;
    constantIp = null;
    ipVaried = false;
    rightmostSeen.clear();
  }

  function fire(issue: ProxyShapeIssue, observedIp: string, message: string, now: number): ProxyShapeReport | null {
    const last = lastWarnAt.get(issue);
    if (last !== undefined && now - last < cooldownMs) return null;
    lastWarnAt.set(issue, now);
    return { issue, message, observedIp };
  }

  return {
    note(input, now = Date.now()) {
      const ip = input.ip || "";
      total += 1;
      if (constantIp === null) constantIp = ip;
      else if (constantIp !== ip) ipVaried = true;

      const header = Array.isArray(input.forwardedFor) ? input.forwardedFor.join(",") : input.forwardedFor;
      if (header) {
        withHeader += 1;
        // 只留前几个就够判「变没变」，不要让 Set 跟着流量长。
        if (rightmostSeen.size < 8) rightmostSeen.add(rightmostForwarded(header));
      }

      if (total < sample) return null;

      // 先把这一窗口的结论抄出来再 reset —— reset 会把 total 清零，
      // 拿清零后的 total 去比 headerCount 会让整条判据永远不成立。
      const windowTotal = total;
      const observedIp = constantIp ?? "";
      const headerCount = withHeader;
      const distinctRightmost = new Set(rightmostSeen);
      distinctRightmost.delete(observedIp);
      const stableIp = !ipVaried;
      reset();

      if (headerCount === windowTotal && stableIp && distinctRightmost.size >= 2) {
        return fire(
          "proxy_header_ignored",
          observedIp,
          `代理头没有被采纳：最近 ${sample} 个请求都带 X-Forwarded-For，但 req.ip 全部是 ${observedIp}。` +
            `限流会把所有访客算进同一个桶，审计日志和登录历史的 ip 列也会全是这一个地址。` +
            `把 ${observedIp} 加进 TRUST_PROXY（本机 nginx 用 loopback，独立网关/容器用它的 IP 或网段）。`,
          now,
        );
      }

      if (headerCount === 0 && stableIp && LOOPBACK_IPS.has(observedIp)) {
        return fire(
          "proxy_header_missing",
          observedIp,
          `最近 ${sample} 个请求都来自 ${observedIp} 且没有 X-Forwarded-For。` +
            `如果前面有反向代理，它没有转发访客地址 —— 参考 deploy/bt-panel/nginx.conf.example ` +
            `加上 proxy_set_header X-Forwarded-For $remote_addr;。本机自测可忽略这条。`,
          now,
        );
      }

      return null;
    },
  };
}

/** 启动日志用的一句话说明。 */
export function describeTrustProxy(option: TrustProxyOption): string {
  if (option === false) {
    return "不信任任何反向代理：req.ip 恒为 TCP 对端地址，X-Forwarded-For 一律忽略";
  }
  return `只信任这些位置转发来的 X-Forwarded-For：${option.join(", ")}`;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/** 传给 Fastify 构造函数的 trustProxy。server.ts 只许用这个，不许写字面量。 */
export const trustProxyOption: TrustProxyOption = parseTrustProxy(parsed.data.TRUST_PROXY);
