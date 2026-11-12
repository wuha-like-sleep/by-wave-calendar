import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";

export const FLASH_COOKIE = "bwc_flash";
const TTL_SECONDS = 120;
const AAD = Buffer.from("bywave:flash:v1");
const key = createHash("sha256").update(AAD).update(env.SESSION_SECRET).digest();
const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: env.NODE_ENV === "production" };
const flashSchema = z.object({
  error: z.string().optional(), success: z.string().optional(),
  newAppPassword: z.string().max(256).optional(), newAppLabel: z.string().max(60).optional(),
  issuedToken: z.string().max(256).optional(), issuedLabel: z.string().max(200).optional(),
});
export type Flash = z.infer<typeof flashSchema>;
const envelopeSchema = z.object({
  path: z.string(), expiresAt: z.number(), flash: flashSchema, session: z.string().optional(),
});
const consumed = new WeakMap<FastifyRequest, Flash>();

function sessionFingerprint(req: FastifyRequest): string | undefined {
  const sid = req.cookies.bwc_sid;
  return sid ? createHash("sha256").update(sid).digest("base64url") : undefined;
}

function boundedMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = "", bytes = 0;
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > 768) return text + "…";
    text += char;
  }
  return text;
}

/** Keep feedback out of URLs. Existing callers may pass legacy query messages. */
export function redirectWithFlash(reply: FastifyReply, destination: string, flash: Flash = {}) {
  if (!destination.startsWith("/") || destination.startsWith("//") || /[\\\r\n]/.test(destination)) {
    throw new Error("Flash redirects must use a local path");
  }
  const target = new URL(destination, "http://local.invalid");
  if (target.origin !== "http://local.invalid") throw new Error("Flash redirects must stay on this site");
  const messages: Flash = {
    ...flash,
    error: boundedMessage(flash.error ?? target.searchParams.get("error") ?? undefined),
    success: boundedMessage(flash.success ?? target.searchParams.get("success") ?? undefined),
  };
  target.searchParams.delete("error");
  target.searchParams.delete("success");
  if (Object.values(messages).some(Boolean)) {
    const hasSecret = Boolean(messages.newAppPassword || messages.issuedToken);
    const session = hasSecret ? sessionFingerprint(reply.request) : undefined;
    if (hasSecret && !session) throw new Error("A session is required for a new credential");
    const plaintext = Buffer.from(JSON.stringify({ path: target.pathname, expiresAt: Date.now() + TTL_SECONDS * 1000, flash: messages, session }));
    if (plaintext.length > 2800) throw new Error("Flash message is too large");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const value = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
    reply.setCookie(FLASH_COOKIE, value, { ...cookieOptions, maxAge: TTL_SECONDS });
    reply.header("Cache-Control", "no-store");
  }
  return reply.redirect(target.pathname + target.search + target.hash);
}

/** Consume only on the destination page; assets and unrelated tabs leave it alone. */
export function readFlash(req: FastifyRequest, reply: FastifyReply): Flash {
  const cached = consumed.get(req);
  if (cached) return cached;
  const empty = {};
  if (req.method !== "GET") return empty;
  const raw = req.cookies[FLASH_COOKIE];
  if (!raw) return empty;
  try {
    if (raw.length > 4000) throw new Error("Invalid flash size");
    const packed = Buffer.from(raw, "base64url");
    if (packed.length < 29) throw new Error("Invalid flash envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(packed.subarray(12, 28));
    const decoded = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    const envelope = envelopeSchema.parse(JSON.parse(decoded.toString("utf8")));
    if (Date.now() >= envelope.expiresAt) throw new Error("Flash expired");
    if (envelope.path !== new URL(req.url, "http://local.invalid").pathname) return empty;
    if ((envelope.flash.newAppPassword || envelope.flash.issuedToken) && (!envelope.session || envelope.session !== sessionFingerprint(req))) {
      throw new Error("Flash belongs to a different session");
    }
    reply.clearCookie(FLASH_COOKIE, cookieOptions);
    reply.header("Cache-Control", "no-store");
    consumed.set(req, envelope.flash);
    return envelope.flash;
  } catch {
    reply.clearCookie(FLASH_COOKIE, cookieOptions);
    reply.header("Cache-Control", "no-store");
    consumed.set(req, empty);
    return empty;
  }
}
