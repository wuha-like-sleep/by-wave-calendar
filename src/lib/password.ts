import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
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
