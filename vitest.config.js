import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // mongodb-memory-server downloads a real mongod binary the first time
    // it runs and then spins up a real (if disposable) MongoDB process —
    // both comfortably slower than the 5s default hook/test timeout,
    // especially in CI. Only the server/*.test.js suites actually pay this
    // cost; a generous ceiling here is harmless for the rest.
    hookTimeout: 60000,
    testTimeout: 30000,
  },
});
