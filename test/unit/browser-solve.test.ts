import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tab } from "../../src/browser/tab.ts";
import { FakeConnection } from "./fake.ts";

/** The page's target. */
const TARGET = "T";
/** What Browserbase writes to the page's console as it solves a verification challenge itself (captcha solving on). */
const STARTED = "browserbase-solving-started";
const FINISHED = "browserbase-solving-finished";
const ERRORED = "browserbase-solving-errored";
/**
 * How long one solving took on Eventbrite's checkout hCaptcha (probes of 2026-11-21: 18 to 42 s), one that errors, and
 * the longest the tab waits (tab.ts BROWSER_SOLVE_MAX_MS) with a second past it.
 */
const SOLVING_MS = 40_000;
const ERROR_MS = 5_000;
const MOST_MS = 60_000;
const PAST_MS = 1_000;
/** What the browser's timings name the wait (tab.ts SOLVE_KIND). */
const SOLVE = "captcha";

/** Tells the tab a line its page wrote to the console. */
function say(browser: FakeConnection, text: string): void {
  browser.tell("Runtime.consoleAPICalled", { type: "info", args: [{ type: "string", value: text }] });
}

describe("waiting for the browser's own solving of a verification challenge", () => {
  let browser: FakeConnection;
  let tab: Tab;

  beforeEach(async () => {
    vi.useFakeTimers();
    browser = new FakeConnection();
    tab = await Tab.attach(browser.connection, TARGET);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not wait when none is going on", async () => {
    say(browser, "recaptchacompat disabled");
    expect(await tab.browserSolve()).toBe("none");
    expect(browser.timings.record().settles[SOLVE]).toBeUndefined();
  });

  it("waits for one going on until it ends solved, in the timings", async () => {
    say(browser, STARTED);
    setTimeout(() => say(browser, FINISHED), SOLVING_MS);
    const solving = tab.browserSolve();
    await vi.advanceTimersByTimeAsync(MOST_MS + PAST_MS);
    expect(await solving).toBe("solved");
    const times = browser.timings.record().settles[SOLVE]!;
    expect(times.ends).toEqual({ solved: 1 });
    expect(times.ms).toBeGreaterThanOrEqual(SOLVING_MS);
    expect(times.ms).toBeLessThan(SOLVING_MS + PAST_MS);
    expect(await tab.browserSolve()).toBe("none");
  });

  it("tells one that ended in an error", async () => {
    say(browser, STARTED);
    setTimeout(() => say(browser, ERRORED), ERROR_MS);
    const solving = tab.browserSolve();
    await vi.advanceTimersByTimeAsync(MOST_MS + PAST_MS);
    expect(await solving).toBe("failed");
  });

  it("stops waiting once the run is stopped", async () => {
    say(browser, STARTED);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), ERROR_MS);
    const solving = tab.browserSolve(undefined, stop.signal);
    await vi.advanceTimersByTimeAsync(MOST_MS + PAST_MS);
    expect(await solving).toBe("unfinished");
    expect(browser.timings.record().settles[SOLVE]!.ms).toBeLessThan(ERROR_MS + PAST_MS);
  });

  it("gives up on one still going at its limit, and does not wait for it again", async () => {
    say(browser, STARTED);
    const solving = tab.browserSolve();
    await vi.advanceTimersByTimeAsync(MOST_MS + PAST_MS);
    expect(await solving).toBe("unfinished");
    expect(browser.timings.record().settles[SOLVE]!.ms).toBeGreaterThanOrEqual(MOST_MS);
    expect(await tab.browserSolve()).toBe("none");
  });
});
