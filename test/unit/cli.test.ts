import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
/** The exit code of a call that cannot be worked as given. */
const USAGE_EXIT = 2;

describe("the command line's run", () => {
  it("names SYSTEM1_MODEL when System 1 has no model, before starting a browser", () => {
    const env = { ...process.env };
    delete env.SYSTEM1_MODEL;
    const ran = spawnSync(process.execPath, [CLI, "run", "--url", "http://127.0.0.1:1/", "--goal", "g"], {
      env,
      encoding: "utf8",
    });
    expect(ran.status).toBe(USAGE_EXIT);
    expect(ran.stderr).toMatch(/SYSTEM1_MODEL/);
  });
});
