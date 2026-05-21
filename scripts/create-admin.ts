import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import * as schema from "../src/db/schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client, { schema });

async function readInteractive() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const email = (await rl.question("Admin email: ")).trim();
    const password = (await rl.question("Admin password (min 8 chars): ")).trim();
    const displayName = (await rl.question("Display name (optional): ")).trim() || null;
    return { email, password, displayName };
  } finally {
    rl.close();
  }
}

async function main() {
  let email = process.env.ADMIN_EMAIL?.trim();
  let password = process.env.ADMIN_PASSWORD?.trim();
  let displayName: string | null = null;

  if (!email || !password) {
    if (!stdin.isTTY) {
      console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set when running non-interactively.");
      process.exit(1);
    }
    const answers = await readInteractive();
    email = answers.email;
    password = answers.password;
    displayName = answers.displayName;
  }

  if (!email.includes("@")) {
    console.error("invalid email");
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exit(1);
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const passwordHash = await bcrypt.hash(password, 12);

  if (existing.length > 0) {
    await db
      .update(schema.users)
      .set({ passwordHash, isAdmin: true, updatedAt: new Date(), displayName: displayName ?? existing[0]!.displayName })
      .where(eq(schema.users.email, email));
    console.log(`updated existing user as admin: ${email}`);
  } else {
    await db.insert(schema.users).values({ email, passwordHash, isAdmin: true, displayName });
    console.log(`created admin: ${email}`);
  }
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
