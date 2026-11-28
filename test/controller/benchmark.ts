/**
 * The configuration of our published benchmark runs, defined once: the System 2 model, the deadline, the controller's
 * options and the browser's. System 2's provider is left to OpenRouter's routing (a single one served our runs).
 * `node test/controller/cli.ts --benchmark` runs with it.
 */
import type { BrowserOptions } from "../../src/index.ts";
import type { ChatModel } from "./chat.ts";
import type { ControlOptions } from "./controller.ts";
import { CONTROLLER_MODELS } from "./models.ts";

/**
 * How long a task may take before the answer is due, in seconds: our runs gave each task this long (the benchmark sets
 * no deadline of its own).
 */
export const BENCHMARK_DEADLINE_S = 450;
const MS_PER_SECOND = 1_000;
/** The most turns System 2 takes in a task. */
const BENCHMARK_MAX_TURNS = 48;
/** How System 1 was asked: a decision is tried twice at most, each try given 30 s. */
const SYSTEM1_ATTEMPTS = 2;
const SYSTEM1_ATTEMPT_MS = 30_000;

/** System 1's tries in the benchmark; its address, model and key come from the SYSTEM1_* variables. */
export const BENCHMARK_SYSTEM1 = { attempts: SYSTEM1_ATTEMPTS, attemptTimeoutMs: SYSTEM1_ATTEMPT_MS } as const;

/** System 2 in the benchmark: DeepSeek V4.1 Flash as its preset gives it, on the provider OpenRouter picks. */
export const BENCHMARK_MODEL: ChatModel = CONTROLLER_MODELS["deepseek-v4.1-flash"]!;

/**
 * What the benchmark sets on the browser besides the library's defaults: System 1's tries, a show that does not find
 * its text as written looks for it loosely, and each step of a run is told with a screenshot at the browser's own
 * width.
 */
export function benchmarkBrowserOptions(): BrowserOptions {
  return { decider: BENCHMARK_SYSTEM1, screenshot: "scaled", revealLoose: true, readableStepShots: true };
}

/** A date as System 2 is told it, in UTC: "Wednesday, 18 November 2026". */
export function todayText(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The controller's options in the benchmark, besides the model: `started` is when the task began (epoch ms), which the
 * deadline counts from, and `now` is the date System 2 is told.
 */
export function benchmarkControlOptions(started: number, now: Date): Omit<ControlOptions, "model"> {
  return {
    unattended: true,
    deadline: started + BENCHMARK_DEADLINE_S * MS_PER_SECOND,
    maxTurns: BENCHMARK_MAX_TURNS,
    quickReasoning: "low",
    multiShow: true,
    openFullPage: true,
    hideSpentHands: true,
    startPageInTask: true,
    pageInAnswers: true,
    today: todayText(now),
    wholeAnswer: true,
    showEvidence: true,
    compare: true,
  };
}
