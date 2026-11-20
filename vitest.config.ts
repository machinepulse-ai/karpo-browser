import { defineConfig } from "vitest/config";

/** The live tests start a browser each, several at once: a cold start under that load takes seconds. */
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({ test: { testTimeout: TEST_TIMEOUT_MS } });
