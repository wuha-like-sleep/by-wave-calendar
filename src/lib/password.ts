import bcrypt from "bcryptjs";

const ROUNDS = 12;

// Pre-computed bcrypt hash of a random ~256-bit value. Used by
// verifyPasswordTimingSafe() when a login attempt arrives for a
// non-existent user: bcrypt-compare against this hash burns the same
// ~250ms of CPU as a real verify would, so the attacker can't tell
// whether the email is registered by measuring response time.
// (Hash generated once with bcryptjs at ROUNDS=12 and frozen here.)
const DUMMY_HASH = "$2a$12$3GVAJUNGYRfPaWdgnQ2yyOzcQGw.j6sHCk0i9JdRZ7JFqVfTXVfTC";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Like verifyPassword, but designed to be called in the "user not found"
// branch of a login flow. Always returns false, and always spends the
// same CPU as a real verifyPassword call so the no-such-user path is
// time-indistinguishable from the wrong-password path. Call this and
// discard the result — don't branch on its return.
export async function verifyPasswordTimingSafe(plain: string): Promise<false> {
  await bcrypt.compare(plain, DUMMY_HASH);
  return false;
}

// Enforce a basic-but-real password policy: ≥10 chars + at least one letter
// AND at least one digit. Pragmatically blocks "12345678" / "password123" /
// "qwertyuiop" while not requiring symbols (which push users to write things
// down on sticky notes). Returns null on pass; a Chinese reason on fail.
export function passwordPolicyError(plain: string): string | null {
  if (plain.length < 10) return "密码至少 10 位";
  if (!/[A-Za-z]/.test(plain)) return "密码必须包含至少一个字母";
  if (!/[0-9]/.test(plain)) return "密码必须包含至少一个数字";
  return null;
}
