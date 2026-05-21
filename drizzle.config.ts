import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://calshare:calshare_dev@127.0.0.1:5432/calshare_dev",
  },
  strict: true,
  verbose: true,
});
