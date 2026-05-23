import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../env.js";
import * as schema from "./schema.js";

const client = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  prepare: false,
  // Keep idle connections warm for 5 minutes — CalDAV bursts arrive in
  // clumps every few minutes; reconnecting between clumps wastes ~50ms
  // per request to TLS+auth handshake against PG.
  idle_timeout: 300,
});

export const db = drizzle(client, { schema });
export { schema };
export type DB = typeof db;
