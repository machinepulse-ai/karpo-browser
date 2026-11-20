import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENT = fileURLToPath(new URL("./agent.ts", import.meta.url));
/** The exit code of an input or a setting the agent cannot work with. */
const REFUSED_EXIT = 2;
/** A task as the harness gives it; nothing listens on its bridge's port. */
const INPUT = JSON.stringify({
  instruction: "Find the price of the book",
  start_url: "https://books.toscrape.com/",
  mcp_servers: { stagehand: { command: "node", args: [], env: { STAGEHAND_EVALS_FACADE_BRIDGE_PORT: "1" } } },
  max_tool_steps: 100,
  run_seconds: 600,
  records_dir: null,
});
/** Every setting the agent needs. */
const SETTINGS = {
  BROWSERBASE_API_KEY: "bb_live_testKeyNotReal_0123456789",
  BROWSERBASE_SESSION_ID: "session",
  SYSTEM1_MODEL: "karpo-decision-27b-act",
  SYSTEM2_API_KEY: "key",
};

/** Runs the agent on the input with these variables alone: its exit code, its events, and all it wrote. */
function agent(env: Record<string, string>, input = INPUT) {
  const ran = spawnSync(process.execPath, [AGENT], { env, input, encoding: "utf8" });
  const events = ran.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: ran.status, events, written: ran.stdout + ran.stderr };
}

describe("the agent, before it connects to anything", () => {
  it("refuses a task without System 1's model, naming the variable", () => {
    const { SYSTEM1_MODEL: _model, ...env } = SETTINGS;
    const ran = agent(env);
    expect(ran.status).toBe(REFUSED_EXIT);
    expect(ran.events).toEqual([expect.objectContaining({ type: "error", kind: "config" })]);
    expect(ran.events[0]?.message).toMatch(/SYSTEM1_MODEL/);
  });

  it("refuses a task without System 2's key", () => {
    const { SYSTEM2_API_KEY: _key, ...env } = SETTINGS;
    const ran = agent(env);
    expect(ran.status).toBe(REFUSED_EXIT);
    expect(ran.events).toEqual([expect.objectContaining({ type: "error", kind: "config" })]);
    expect(ran.events[0]?.message).toMatch(/SYSTEM2_API_KEY/);
  });

  it("refuses a task without the Browserbase session the harness gives", () => {
    const { BROWSERBASE_SESSION_ID: _session, ...env } = SETTINGS;
    const ran = agent(env);
    expect(ran.status).toBe(REFUSED_EXIT);
    expect(ran.events[0]?.message).toMatch(/BROWSERBASE_SESSION_ID/);
  });

  it("refuses an input that is not JSON, without a stack", () => {
    const ran = agent(SETTINGS, "not json");
    expect(ran.status).toBe(REFUSED_EXIT);
    expect(ran.events).toEqual([expect.objectContaining({ type: "error", kind: "config" })]);
    expect(ran.written).not.toMatch(/\n\s+at /);
  });
});
