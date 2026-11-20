import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** The exit code of a call that cannot be worked as given. */
const USAGE_EXIT = 2;

describe("the controller's command line", () => {
  it("names SYSTEM2_MODEL and the presets when no model is set, before starting a browser", () => {
    const env = { ...process.env };
    delete env.SYSTEM2_MODEL;
    const ran = spawnSync(process.execPath, [CLI, "Find the price"], { env, encoding: "utf8" });
    expect(ran.status).toBe(USAGE_EXIT);
    expect(ran.stderr).toMatch(/SYSTEM2_MODEL/);
    expect(ran.stderr).toMatch(/deepseek-v4\.1-flash/);
  });

  it("prints its usage without a task", () => {
    const ran = spawnSync(process.execPath, [CLI], { env: { ...process.env, SYSTEM2_MODEL: "x" }, encoding: "utf8" });
    expect(ran.status).toBe(USAGE_EXIT);
    expect(ran.stderr).toMatch(/usage: node test\/controller\/cli\.ts/);
  });

  it("names SYSTEM1_MODEL when System 1 has no model, before starting a browser", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SYSTEM2_MODEL: "x", SYSTEM2_API_KEY: "k" };
    delete env.SYSTEM1_MODEL;
    const ran = spawnSync(process.execPath, [CLI, "Find the price"], { env, encoding: "utf8" });
    expect(ran.status).toBe(USAGE_EXIT);
    expect(ran.stderr).toMatch(/SYSTEM1_MODEL/);
  });

  it("names SYSTEM2_API_KEY when System 2 has no key and no local server, before starting a browser", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SYSTEM2_MODEL: "x", SYSTEM1_MODEL: "m" };
    delete env.SYSTEM2_API_KEY;
    delete env.SYSTEM2_BASE_URL;
    const ran = spawnSync(process.execPath, [CLI, "Find the price"], { env, encoding: "utf8" });
    expect(ran.status).toBe(USAGE_EXIT);
    expect(ran.stderr).toMatch(/SYSTEM2_API_KEY/);
  });
});
