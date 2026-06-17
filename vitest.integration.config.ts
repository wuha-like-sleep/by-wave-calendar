import { defineConfig } from "vitest/config";

// On-demand integration suite: real DB code paths against in-memory PGlite.
// Run with `npm run test:int` (NOT part of `npm test`, which stays pure-logic).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
