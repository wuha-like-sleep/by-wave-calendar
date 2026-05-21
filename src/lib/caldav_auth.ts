import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { verifyPassword } from "./password.js";

const REALM = "ByWave Calendar CalDAV";

export async function basicAuth(req: FastifyRequest, reply: FastifyReply): Promise<schema.User | null> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("basic ")) {
    reply.header("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    reply.code(401).type("text/plain").send("Unauthorized");
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    reply.code(401).type("text/plain").send("Bad auth");
    return null;
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) {
    reply.header("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    reply.code(401).type("text/plain").send("Bad auth");
    return null;
  }
  const email = decoded.slice(0, colonIdx).toLowerCase().trim();
  const password = decoded.slice(colonIdx + 1);

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) {
    reply.header("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    reply.code(401).type("text/plain").send("Unauthorized");
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    reply.header("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    reply.code(401).type("text/plain").send("Unauthorized");
    return null;
  }
  return user;
}
