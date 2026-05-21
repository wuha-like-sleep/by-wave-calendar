import { generateSecret, generateURI, verifySync } from "otplib";
import { randomBytes, createHash } from "node:crypto";
import QRCode from "qrcode";
import { env } from "../env.js";

export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function totpKeyUri(email: string, secret: string): string {
  const issuer = new URL(env.PUBLIC_BASE_URL).hostname;
  return generateURI({
    strategy: "totp",
    issuer,
    label: email,
    secret,
    digits: 6,
    period: 30,
  });
}

export async function totpQrDataUrl(email: string, secret: string): Promise<string> {
  return QRCode.toDataURL(totpKeyUri(email, secret), { margin: 1, width: 240 });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    const token = code.trim().replace(/\s+/g, "");
    if (!/^\d{6,8}$/.test(token)) return false;
    const result = verifySync({
      strategy: "totp",
      secret,
      token,
      digits: 6,
      period: 30,
      epochTolerance: 1,
    });
    return result.valid === true;
  } catch {
    return false;
  }
}

export type BackupCode = { hash: string; used: boolean };

export function generateBackupCodes(count = 10): { plain: string[]; stored: BackupCode[] } {
  const plain: string[] = [];
  const stored: BackupCode[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-");
    plain.push(code);
    stored.push({ hash: hashCode(code), used: false });
  }
  return { plain, stored };
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase().replace(/\s+/g, "")).digest("hex");
}

export function consumeBackupCode(codes: BackupCode[], input: string): { ok: boolean; updated: BackupCode[] } {
  const target = hashCode(input);
  let used = false;
  const updated = codes.map((c) => {
    if (!used && !c.used && c.hash === target) {
      used = true;
      return { ...c, used: true };
    }
    return c;
  });
  return { ok: used, updated };
}
