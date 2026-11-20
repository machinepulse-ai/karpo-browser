import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettleEnd, SettleRules } from "../../src/browser/tab.ts";
import { SETTLE_RULES, Tab } from "../../src/browser/tab.ts";
import { FakeConnection } from "./fake.ts";

/** The page's target, whose id its own frame has too, and a frame inside it. */
const TARGET = "T";
const INNER_FRAME = "F2";
/** The longest a settle is given here, as an open's is, and a shorter one. */
const OPEN_SETTLE_MS = 6_000;
const SHORT_SETTLE_MS = 2_000;
/**
 * How long the document must stay unchanged once complete (tab.ts OPEN_QUIET_MS), and the age past which a request is
 * a long poll (tab.ts LONG_REQUEST_MS).
 */
const OPEN_QUIET_MS = 500;
const LONG_REQUEST_MS = 5_000;
/** Long before the settle, when a document that has stood still last changed. */
const LONG_AGO_MS = 60_000;
/** How long after the open the data the page asked for comes back and is drawn, and how long before it one began. */
const ANSWER_MS = 1_500;
const BEFORE_MS = 100;
const OPEN = "open";
/** What the timings name an action's settle, one by itself and a wait's (tab.ts). */
const ACTION = "action";
const SETTLE = "settle";
const WAIT = "wait";
/** Quicker rules than the tab's own (tab.ts SETTLE_QUIET_MS 300, SETTLE_NETWORK_QUIET_MS 500). */
const QUICK: SettleRules = { quietMs: 100, networkQuietMs: 200 };
/** Long enough after the tab attached for its network to count as quiet by either rules. */
const NETWORK_QUIET_MS = 1_000;

/** A request the page sends from a frame, of a type, that never ends. */
function request(browser: FakeConnection, id: string, type: string, frameId = TARGET): void {
  browser.tell("Network.requestWillBeSent", {
    requestId: id,
    type,
    frameId,
    loaderId: "L",
    request: { url: `https://site.test/${id}` },
  });
}

/** A settle run to its end, the clock moved on as it waits: how it ended, and how long it took. */
async function timed(browser: FakeConnection, settle: Promise<SettleEnd>): Promise<{ end: SettleEnd; ms: number }> {
  await vi.runAllTimersAsync();
  const end = await settle;
  const settles = browser.timings.record().settles[OPEN]!;
  return { end, ms: settles.ms };
}

describe("a settle after a page opened", () => {
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

  it("ends once the document is complete and quiet, whatever other requests are still open", async () => {
    browser.page = { ready: "complete", changedAt: Date.now() - LONG_AGO_MS };
    request(browser, "poll", "Fetch");
    await vi.advanceTimersByTimeAsync(BEFORE_MS);
    request(browser, "pixel", "Image");
    request(browser, "beacon", "Other");
    request(browser, "ad", "Script", INNER_FRAME);
    expect(await timed(browser, tab.settleOpened(OPEN_SETTLE_MS, OPEN))).toEqual({
      end: "document_complete",
      ms: OPEN_QUIET_MS,
    });
  });

  it("waits for the data and code the page's own frame asked for since it opened, and for what they drew", async () => {
    for (const type of ["Fetch", "XHR", "Script"]) {
      const opened = new FakeConnection();
      opened.page = { ready: "complete", changedAt: Date.now() - LONG_AGO_MS };
      const page = await Tab.attach(opened.connection, TARGET);
      request(opened, "pixel", "Image");
      const settle = page.settleOpened(OPEN_SETTLE_MS, OPEN);
      request(opened, "results", type);
      setTimeout(() => {
        opened.tell("Network.loadingFinished", { requestId: "results" });
        opened.page.changedAt = Date.now();
      }, ANSWER_MS);
      expect(await timed(opened, settle)).toEqual({ end: "document_complete", ms: ANSWER_MS + OPEN_QUIET_MS });
    }
  });

  it("waits as long as an action's settle does when off", async () => {
    browser.page = { ready: "complete", changedAt: Date.now() - LONG_AGO_MS };
    request(browser, "tracker", "Script");
    const { end, ms } = await timed(browser, tab.settle(OPEN_SETTLE_MS, OPEN));
    expect(end).toBe("quiet");
    expect(ms).toBeGreaterThan(LONG_REQUEST_MS);
  });

  it("waits for a document that changed lately to stand still", async () => {
    browser.page = { ready: "complete", changedAt: Date.now() };
    setTimeout(() => {
      browser.page.changedAt = Date.now();
    }, OPEN_QUIET_MS);
    request(browser, "pixel", "Image");
    expect(await timed(browser, tab.settleOpened(OPEN_SETTLE_MS, OPEN))).toEqual({
      end: "document_complete",
      ms: 2 * OPEN_QUIET_MS,
    });
  });

  it("waits for a document not yet complete, to its cap", async () => {
    browser.page = { ready: "interactive", changedAt: Date.now() - LONG_AGO_MS };
    request(browser, "tracker", "Script");
    const { end, ms } = await timed(browser, tab.settleOpened(SHORT_SETTLE_MS, OPEN));
    expect(end).toBe("cap_action_requests");
    expect(ms).toBeGreaterThanOrEqual(SHORT_SETTLE_MS);
  });

  it("waits while a new document loads in the page's own frame, but not in a frame inside it", async () => {
    browser.page = { ready: "complete", changedAt: Date.now() - LONG_AGO_MS };
    request(browser, "next page", "Document");
    const own = await timed(browser, tab.settleOpened(SHORT_SETTLE_MS, OPEN));
    expect(own.end).toBe("cap_document_loading");
    expect(own.ms).toBeGreaterThanOrEqual(SHORT_SETTLE_MS);

    const other = new FakeConnection();
    other.page = { ready: "complete", changedAt: Date.now() - LONG_AGO_MS };
    const framed = await Tab.attach(other.connection, TARGET);
    request(other, "ad", "Document", INNER_FRAME);
    expect(await timed(other, framed.settleOpened(SHORT_SETTLE_MS, OPEN))).toEqual({
      end: "document_complete",
      ms: OPEN_QUIET_MS,
    });
  });
});

describe("a settle after an action, by the rules it is given", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A settle on a tab attached `quietFor` ms before, its document changed `changedMs` before (now: just changed): how
   * it ended, and how long the timings say it took under `kind`.
   */
  async function settled(
    settle: (tab: Tab) => Promise<SettleEnd>,
    kind: string,
    quietFor: number,
    changedMs = 0,
  ): Promise<{ end: SettleEnd; ms: number }> {
    const browser = new FakeConnection();
    const tab = await Tab.attach(browser.connection, TARGET);
    await vi.advanceTimersByTimeAsync(quietFor);
    browser.page = { ready: "complete", changedAt: Date.now() - changedMs };
    const ending = settle(tab);
    await vi.runAllTimersAsync();
    return { end: await ending, ms: browser.timings.record().settles[kind]!.ms };
  }

  it("waits for the document to stand still as long as the rules say, the tab's own when none are given", async () => {
    const after = (rules?: SettleRules) => (tab: Tab) => tab.settleAfter(Date.now(), SHORT_SETTLE_MS, rules);
    const by = (rules?: SettleRules) => (tab: Tab) => tab.settle(SHORT_SETTLE_MS, SETTLE, rules);
    // A wait for a change: the document changed just after the wait began, and the settle then goes by the rules.
    const waited = (rules?: SettleRules) => (tab: Tab) =>
      tab.changed(Date.now() - 1, Date.now() + SHORT_SETTLE_MS, rules);
    for (const [settle, kind] of [
      [after, ACTION],
      [by, SETTLE],
      [waited, WAIT],
    ] as const) {
      expect(await settled(settle(), kind, NETWORK_QUIET_MS), kind).toEqual({ end: "quiet", ms: 300 });
      expect(await settled(settle(SETTLE_RULES), kind, NETWORK_QUIET_MS), kind).toEqual({ end: "quiet", ms: 300 });
      expect(await settled(settle(QUICK), kind, NETWORK_QUIET_MS), kind).toEqual({ end: "quiet", ms: QUICK.quietMs });
    }
  });

  it("waits for the page's network to stand still as long as the rules say", async () => {
    const own = await settled((tab) => tab.settleAfter(Date.now(), SHORT_SETTLE_MS), ACTION, 0, LONG_AGO_MS);
    expect(own).toEqual({ end: "quiet", ms: 500 });
    const quick = await settled((tab) => tab.settleAfter(Date.now(), SHORT_SETTLE_MS, QUICK), ACTION, 0, LONG_AGO_MS);
    expect(quick).toEqual({ end: "quiet", ms: QUICK.networkQuietMs });
  });
});
