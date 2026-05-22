import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Pure-logic suite — no DB, no network. Anything that needs a
    // running Postgres / SMTP should live in a separate integration
    // suite we run on demand, not on every `npm test`.
    environment: "node",
    // Surface uncaught promise rejections as failures instead of
    // letting them sit silently.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
