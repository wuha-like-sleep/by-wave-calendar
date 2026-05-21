import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { verifyPassword } from "./password.js";
import { looksLikeAppPassword, verifyAppPassword } from "./app_password.js";
import { userIsActive } from "./user_state.js";

const REALM = "ByWave Calendar CalDAV";

// Bcrypt CPU cost is proportional to input length (up to its 72-byte truncation
// limit, but the UTF-8 decode + string allocation still scales). Cap the
// basic-auth password before we hand it to verifyPassword, otherwise a
// multi-megabyte basic header is a free CPU-burn attack.
const MAX_PASSWORD_BYTES = 256;

function send401(reply: FastifyReply, body: string, errParam?: string): null {
  // RFC 6750 / RFC 7235 style: optional error= param so CalDAV clients that
  // surface it (DAVx⁵ on Android, Thunderbird) show a useful hint.
  const challenge = errParam
    ? `Basic realm="${REALM}", charset="UTF-8", error="${errParam}"`
    : `Basic realm="${REALM}", charset="UTF-8"`;
  reply.header("WWW-Authenticate", challenge);
  reply.code(401).type("text/plain").send(body);
  return null;
}

export async function basicAuth(req: FastifyRequest, reply: FastifyReply): Promise<schema.User | null> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("basic ")) return send401(reply, "Unauthorized");

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return send401(reply, "Bad auth");
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return send401(reply, "Bad auth");

  const email = decoded.slice(0, colonIdx).toLowerCase().trim();
  const password = decoded.slice(colonIdx + 1);
  // Length cap (see MAX_PASSWORD_BYTES comment above).
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return send401(reply, "Bad auth");

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) return send401(reply, "Unauthorized");

  let ok = false;
  let usedAppPassword = false;
  if (looksLikeAppPassword(password)) {
    ok = await verifyAppPassword(user.id, password);
    if (ok) usedAppPassword = true;
  }
  // MFA-on-but-primary-password-attempt is a UX trap: the user enabled MFA
  // expecting their account password to stop working over CalDAV, but it
  // silently kept working — so they never created an app password, and
  // when admin later rotates passwords CalDAV breaks with no clue why.
  //
  // Only try primary password when MFA is OFF. If MFA is ON, the only
  // valid credential is an app password; emit a clear hint via the
  // error= parameter so clients can surface it.
  if (!ok && !user.mfaEnabled) {
    ok = await verifyPassword(password, user.passwordHash);
  } else if (!ok && user.mfaEnabled && !usedAppPassword) {
    // We never even tried the primary password, but mention the actual
    // remediation: create an app password.
    return send401(reply, "MFA 已启用 — 请在 /app/settings 创建应用密码", "mfa_requires_app_password");
  }
  if (!ok) return send401(reply, "Unauthorized");

  // Disabled-account gate: an admin may have disabled this user after the
  // CalDAV client cached the password. Reject so Apple Calendar / Thunderbird
  // stop syncing immediately.
  if (!userIsActive(user)) return send401(reply, "Account disabled", "account_disabled");

  return user;
}
