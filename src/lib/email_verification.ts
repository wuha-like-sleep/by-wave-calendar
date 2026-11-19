import { createHash, randomInt } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { getSettings } from "./site_settings.js";
import { sendMail } from "./mailer.js";
import { verificationCodeMail } from "./email_templates.js";
import { env } from "../env.js";

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;

export function genCode(): string {
  // 6-digit zero-padded
  const n = randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// ---------------------------------------------------------------------------
// 验证码猜测的 (IP, 邮箱) 失败节流。
//
// 上面的 attempts 上限（每码 6 次）只约束**单个码**：issueCode 是整行替换，
// 重新发码就把 attempts 清回 0 —— 每码上限单独看是严的，串起来却是无限次
// 猜测。这里补跨码的第二层：同一 (IP, 邮箱) 的失败累计到站点登录锁定的
// 同一套阈值（lockoutThreshold / lockoutMinutes，管理员在站点设置里统一
// 调）后，该 (IP, 邮箱) 在锁定窗口内一律拒绝，连正确码也不放行 —— 和
// 登录锁定「锁定期内密码对了也不让进」同一口径，不另造阈值体系。
//
// 维度选 (IP, 邮箱) 而不是只按邮箱：攻击者只能锁死**自己这个 IP** 对
// 某个邮箱的验证，锁不住邮箱主人从自己网络提交 —— 不会变成拿锁定去
// 骚扰受害者的工具。issueCode **不**清这个计数（清了第二层就不存在了）。
// 计数放内存（沿用 caldav_throttle 的模式）：重启清零可接受 —— 重启后
// 每码 6 次上限仍在，且重新攒满阈值需要真实失败次数。
// ---------------------------------------------------------------------------
type VerifyFailEntry = { count: number; blockedUntil: number; lastSeen: number };
const verifyFailMap = new Map<string, VerifyFailEntry>();
const VERIFY_FAIL_MAP_CAP = 20_000;
const VERIFY_FAIL_TTL_MS = 24 * 60 * 60 * 1000;

function verifyFailKey(ip: string, email: string): string {
  return `${ip}\n${email}`;
}

function pruneVerifyFailMap(now: number): void {
  if (verifyFailMap.size < VERIFY_FAIL_MAP_CAP) return;
  for (const [k, v] of verifyFailMap) {
    if (now - v.lastSeen > VERIFY_FAIL_TTL_MS && v.blockedUntil <= now) verifyFailMap.delete(k);
  }
  while (verifyFailMap.size >= VERIFY_FAIL_MAP_CAP) {
    const oldest = verifyFailMap.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    verifyFailMap.delete(oldest);
  }
}

/** 该 (IP, 邮箱) 是否正处在验证码锁定窗口内。设置里关掉登录锁定时不拦。 */
async function isVerifyPairBlocked(ip: string, email: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.lockoutEnabled) return false;
  const entry = verifyFailMap.get(verifyFailKey(ip, email));
  return !!entry && entry.blockedUntil > Date.now();
}

/** 记一次验证码猜错；攒到登录锁定阈值就进入锁定窗口并把计数清零重新攒
 *  （和 login_lockout.recordFailedLogin 到阈值时的处理一致）。 */
async function recordVerifyPairFailure(ip: string, email: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.lockoutEnabled) return;
  const now = Date.now();
  const key = verifyFailKey(ip, email);
  const entry = verifyFailMap.get(key) ?? { count: 0, blockedUntil: 0, lastSeen: now };
  entry.count += 1;
  entry.lastSeen = now;
  if (entry.count >= settings.lockoutThreshold) {
    entry.blockedUntil = now + settings.lockoutMinutes * 60_000;
    entry.count = 0;
  }
  verifyFailMap.set(key, entry);
  pruneVerifyFailMap(now);
}

function clearVerifyPairFailures(ip: string, email: string): void {
  verifyFailMap.delete(verifyFailKey(ip, email));
}

export function __resetVerifyCodeThrottleForTest(): void {
  verifyFailMap.clear();
}

export type PendingRegistration = {
  passwordHash: string;
  displayName: string | null;
  /** When registrationMode === "invite": the invite token to consume on success. */
  inviteToken?: string | null;
};

export async function issueCode(email: string, payload: PendingRegistration): Promise<{ ok: boolean; code?: string }> {
  const code = genCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db
    .insert(schema.emailVerifications)
    .values({ email, codeHash, payload: payload as unknown as object, expiresAt, attempts: 0 })
    .onConflictDoUpdate({
      target: schema.emailVerifications.email,
      set: { codeHash, payload: payload as unknown as object, expiresAt, attempts: 0, createdAt: new Date() },
    });

  const mail = verificationCodeMail(email, code);
  const res = await sendMail(mail);
  if (!res.ok) {
    if (env.NODE_ENV === "development") return { ok: true, code };
    return { ok: false };
  }
  return { ok: true };
}

export async function verifyCode(
  email: string,
  code: string,
  ip?: string,
): Promise<{ ok: boolean; reason?: "no_pending" | "expired" | "too_many_attempts" | "wrong"; payload?: PendingRegistration }> {
  // (IP, 邮箱) 跨码节流先行：锁定窗口内连正确码也拒绝，理由沿用
  // too_many_attempts（页面文案现成）。不传 ip 的调用方（理论上不该有）
  // 只走每码上限那一层，保持旧行为。
  if (ip && (await isVerifyPairBlocked(ip, email))) {
    return { ok: false, reason: "too_many_attempts" };
  }
  const [row] = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.email, email))
    .limit(1);
  if (!row) return { ok: false, reason: "no_pending" };
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.email, email));
    return { ok: false, reason: "expired" };
  }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const codeHash = hashCode(code.trim());
  if (codeHash !== row.codeHash) {
    await db
      .update(schema.emailVerifications)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.emailVerifications.email, email));
    if (ip) await recordVerifyPairFailure(ip, email);
    return { ok: false, reason: "wrong" };
  }

  const payload = row.payload as unknown as PendingRegistration;
  await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.email, email));
  if (ip) clearVerifyPairFailures(ip, email);
  return { ok: true, payload };
}

export async function cleanupExpired(): Promise<void> {
  await db.delete(schema.emailVerifications).where(lt(schema.emailVerifications.expiresAt, new Date()));
}
