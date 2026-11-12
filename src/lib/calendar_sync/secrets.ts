import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../../env.js";
const key = createHash("sha256").update("bywave:outlook-tokens:v1:").update(env.SESSION_SECRET).digest();
/** Bind ciphertext to its owner so copying a database value cannot switch accounts. */
export function sealToken(owner: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(owner));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function openToken(owner: string, value: string): string {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 29) throw new Error("invalid_token_envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
