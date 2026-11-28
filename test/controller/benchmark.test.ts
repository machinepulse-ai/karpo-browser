import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_DEADLINE_S,
  BENCHMARK_MODEL,
  benchmarkBrowserOptions,
  benchmarkControlOptions,
  todayText,
} from "./benchmark.ts";
import { CONTROLLER_MODELS } from "./models.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** The exit code of a call that cannot be worked as given. */
const USAGE_EXIT = 2;
const STARTED = Date.UTC(2026, 10, 18, 12, 0, 0);

describe("the benchmark configuration", () => {
  it("gives the answer 450 s from the start", () => {
    expect(BENCHMARK_DEADLINE_S).toBe(450);
    expect(benchmarkControlOptions(STARTED, new Date(STARTED)).deadline).toBe(STARTED + 450_000);
  });

  it("sets the controller's options", () => {
    expect(benchmarkControlOptions(STARTED, new Date(STARTED))).toEqual({
      unattended: true,
      deadline: STARTED + 450_000,
      maxTurns: 48,
      quickReasoning: "low",
      multiShow: true,
      openFullPage: true,
      hideSpentHands: true,
      startPageInTask: true,
      pageInAnswers: true,
      today: "Wednesday, 18 November 2026",
      wholeAnswer: true,
      showEvidence: true,
      compare: true,
      checkFirst: true,
    });
  });

  it("tells the date in UTC, whatever the hour", () => {
    expect(todayText(new Date("2026-11-18T23:59:00Z"))).toBe("Wednesday, 18 November 2026");
    expect(todayText(new Date("2026-11-19T00:01:00Z"))).toBe("Thursday, 19 November 2026");
  });

  it("runs DeepSeek V4.1 Flash as its preset gives it, leaving the provider to OpenRouter", () => {
    expect(BENCHMARK_MODEL).toEqual(CONTROLLER_MODELS["deepseek-v4.1-flash"]);
    expect(BENCHMARK_MODEL).not.toHaveProperty("provider");
  });

  it("sets System 1's tries as our runs had them, and on the browser what the library does not do by default", () => {
    expect(benchmarkBrowserOptions()).toEqual({
      decider: { attempts: 2, attemptTimeoutMs: 30_000 },
      screenshot: "scaled",
      revealLoose: true,
      readableStepShots: true,
    });
  });
});

describe("the controller's command line with --benchmark", () => {
  it("does not need SYSTEM2_MODEL: it goes on to System 1's settings, before starting a browser", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SYSTEM2_API_KEY: "k" };
    delete env.SYSTEM2_MODEL;
    delete env.SYSTEM1_MODEL;
    const ran = spawnSync(process.execPath, [CLI, "--benchmark", "Find the price"], { env, encoding: "utf8" });
    expect(ran.status).toBe(USAGE_EXIT);
    expect(ran.stderr).toMatch(/SYSTEM1_MODEL/);
    expect(ran.stderr).not.toMatch(/SYSTEM2_MODEL/);
  });
});
