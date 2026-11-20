import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import type { SettleRules, Tab } from "../../src/browser/tab.ts";
import { SETTLE_RULES } from "../../src/browser/tab.ts";
import type { AskContext, Decider, DecisionRequest } from "../../src/decider/systemone.ts";
import type { BrowserOptions } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";
import type { Profile } from "../../src/profile.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import type { RunOptions, RunResult } from "../../src/run/run.ts";
import { run } from "../../src/run/run.ts";
import type { Asked, MadePage } from "./fake.ts";
import { button, FakeTab, fingerprint, heading, link, main, pagesOf, scripted } from "./fake.ts";

const SHOP = "https://shop.test";
const ITEM_ADDRESS = `${SHOP}/item/1`;
const GOAL = "Find the price of the trail runner";

function results(): MadePage {
  return {
    url: `${SHOP}/results`,
    title: "Results",
    body: [main(heading("1 result"), link("Trail runner", "/item/1"))],
  };
}

function item(): MadePage {
  const body = [main(heading("Trail runner"), "Price $40", button("Add to cart"))];
  return { url: ITEM_ADDRESS, title: "Trail runner", body, firstId: 100 };
}

/** A tab on a shop of one item, at its list of results. */
function shop(): FakeTab {
  return new FakeTab({ start: "results", pages: { results, item } });
}

/** Opens the item, waits on it, goes back to the list, then is done. */
function shopping(): (asked: Asked) => string {
  let taken = 0;
  return (asked) => {
    taken += 1;
    if (taken === 1) return `CLICK ${asked.numberOf("link Trail runner")}`;
    if (taken === 2) return "WAIT";
    return taken === 3 ? "BACK" : "DONE";
  };
}

/** What a browser settles by when the options leave the rules out. */
const DEFAULT_RULES: SettleRules = { quietMs: 200, networkQuietMs: 300 };
/** Quicker settle rules than the tab's own, and a shorter longest settle than act.ts's own (2 s). */
const QUICK: SettleRules = { quietMs: 150, networkQuietMs: 250 };
const QUICK_MAX_MS = 1_200;
/** How long the made-up tab takes to give a screenshot here, and a grace far shorter and one far longer than it. */
const SHOT_MS = 200;
const SHORT_GRACE_MS = 20;
const LONG_GRACE_MS = 1_000;
/** A budget in tokens far below any request's, and the tokens a 768 × 432 screenshot takes (decider/screenshot.ts). */
const TINY_BUDGET = 50;
const SHOT_TOKENS = 24 * 14 + 2;

/** A decision model as `scripted`, that keeps the screenshot each request was asked with too. */
function seeing(step: (asked: Asked) => string): Decider & { requests: DecisionRequest[]; images: unknown[] } {
  const decider = scripted(step);
  const images: unknown[] = [];
  return {
    requests: decider.requests,
    images,
    ask: (request: DecisionRequest, context: AskContext) => {
      images.push(context.image);
      return decider.ask(request, context);
    },
  };
}

interface Ran {
  result: RunResult;
  requests: DecisionRequest[];
  images: unknown[];
  tab: FakeTab;
}

/** A shopping run on a tab, its clock held still (its timers not), with the options given. */
async function ranOn(tab: FakeTab, options: Partial<RunOptions>): Promise<Ran> {
  const decider = seeing(shopping());
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const result = await run(pagesOf(tab), { goal: GOAL }, { profile: DEFAULT_PROFILE, decider, ...options });
    return { result, requests: decider.requests, images: decider.images, tab };
  } finally {
    vi.useRealTimers();
  }
}

/** A browser on a tab, as `launch` and `connect` make it. */
function browserOn(tab: FakeTab, options: BrowserOptions): Browser {
  const made = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
  return new made({} as Connection, tab.tab, options);
}

/** A shopping run through a browser with the options given, its clock held still (its timers not). */
async function browsedOn(tab: FakeTab, options: BrowserOptions): Promise<Ran> {
  const decider = seeing(shopping());
  const browser = browserOn(tab, { ...options, decider });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const result = await browser.run({ goal: GOAL });
    return { result, requests: decider.requests, images: decider.images, tab };
  } finally {
    vi.useRealTimers();
  }
}

describe("the settles of a run's steps", () => {
  it("settle after an action and wait for a change by act.ts's rules and longest time, unless told others", async () => {
    const own = await ranOn(shop(), { screenshot: "none" });
    const told = await ranOn(shop(), { screenshot: "none", settling: { maxMs: QUICK_MAX_MS, rules: QUICK } });
    const settles = (maxMs: number) => [
      ["settleAfter", maxMs, "action"],
      ["changed", undefined, "wait"],
      ["changed", undefined, "wait"],
      ["settleAfter", maxMs, "action"],
    ];
    expect([own.result.status, own.tab.settles, own.tab.rules]).toEqual([
      "done",
      settles(2_000),
      Array(4).fill(undefined),
    ]);
    expect([told.result.status, told.tab.settles, told.tab.rules]).toEqual([
      "done",
      settles(QUICK_MAX_MS),
      Array(4).fill(QUICK),
    ]);
    expect(told.requests.map(fingerprint)).toEqual(own.requests.map(fingerprint));
  });

  it("are a browser's options, as are the settles of an action by hand and of a text shown, not an open's", async () => {
    const settled = async (options: BrowserOptions) => {
      const tab = shop();
      tab.evaluate = async () => true;
      const browser = browserOn(tab, { ...options, screenshot: "none", decider: scripted(() => "DONE") });
      await browser.open(ITEM_ADDRESS);
      const number = Number(/^\s*(\d+) button Add to cart/m.exec((await browser.read()).lines.join("\n"))?.[1]);
      await browser.act({ kind: "click", element: number });
      await browser.reveal("Price $40");
      return { settles: tab.settles, rules: tab.rules };
    };
    expect(await settled({})).toEqual({
      settles: [
        ["settleOpened", 3_500, "open"],
        ["settleAfter", 1_500, "action"],
        ["settle", 1_000, undefined],
      ],
      rules: [undefined, DEFAULT_RULES, DEFAULT_RULES],
    });
    expect(
      await settled({ settleQuietMs: 300, settleNetworkQuietMs: 500, actionSettleMaxMs: 2_000, fastOpenSettle: false }),
    ).toEqual({
      settles: [
        ["settle", 3_500, "open"],
        ["settleAfter", 2_000, "action"],
        ["settle", 1_000, undefined],
      ],
      rules: [undefined, SETTLE_RULES, SETTLE_RULES],
    });
    const options = { settleQuietMs: QUICK.quietMs, settleNetworkQuietMs: QUICK.networkQuietMs };
    expect(await settled({ ...options, actionSettleMaxMs: QUICK_MAX_MS })).toEqual({
      settles: [
        ["settleOpened", 3_500, "open"],
        ["settleAfter", QUICK_MAX_MS, "action"],
        ["settle", 1_000, undefined],
      ],
      rules: [undefined, QUICK, QUICK],
    });
    const ran = await browsedOn(shop(), { ...options, actionSettleMaxMs: QUICK_MAX_MS, screenshot: "none" });
    expect([ran.result.status, ran.tab.settles[0], ran.tab.rules]).toEqual([
      "done",
      ["settleAfter", QUICK_MAX_MS, "action"],
      Array(4).fill(QUICK),
    ]);
  });
});

describe("a step's screenshot for the decision model", () => {
  it("is left out with deciderScreenshot none, the browser's own screenshot still taken", async () => {
    const shown = await browsedOn(shop(), { screenshot: "scaled" });
    expect([shown.result.status, shown.tab.shots, shown.images.every((image) => image !== undefined)]).toEqual([
      "done",
      shown.requests.length,
      true,
    ]);
    const tab = shop();
    const unseen = await browsedOn(tab, { screenshot: "scaled", deciderScreenshot: "none" });
    expect([unseen.result.status, tab.shots, unseen.images]).toEqual(["done", 0, Array(4).fill(undefined)]);
    const none = await browsedOn(shop(), { screenshot: "none" });
    expect(unseen.requests.map(fingerprint)).toEqual(none.requests.map(fingerprint));
    expect(await browserOn(tab, { screenshot: "scaled", deciderScreenshot: "none" }).screenshot()).toBeDefined();
    expect(tab.shots).toBe(1);
  });

  it("takes none of the budget when it is left out", async () => {
    const decider = {
      ...DEFAULT_PROFILE.decider,
      contextWindow: DEFAULT_PROFILE.decider.maxOutputTokens + TINY_BUDGET,
    };
    const profile: Profile = { ...DEFAULT_PROFILE, decider };
    const shown = await browsedOn(shop(), { profile, screenshot: "scaled" });
    const unseen = await browsedOn(shop(), { profile, screenshot: "scaled", deciderScreenshot: "none" });
    expect([shown.result.status, shown.result.detail]).toEqual([
      "failed",
      expect.stringContaining(`budget of ${Math.max(TINY_BUDGET - SHOT_TOKENS, 0)}`),
    ]);
    expect([unseen.result.status, unseen.result.detail]).toEqual([
      "failed",
      expect.stringContaining(`budget of ${TINY_BUDGET}`),
    ]);
  });

  it("is waited for no longer than screenshotGraceMs once the page is read: a late one is left out", async () => {
    const slow = () => {
      const tab = shop();
      tab.shotMs = SHOT_MS;
      return tab;
    };
    const waited = await ranOn(slow(), { screenshot: "scaled" });
    const graced = await ranOn(slow(), { screenshot: "scaled", screenshotGraceMs: LONG_GRACE_MS });
    const late = await ranOn(slow(), { screenshot: "scaled", screenshotGraceMs: SHORT_GRACE_MS });
    const none = await ranOn(shop(), { screenshot: "none" });
    expect(waited.images.every((image) => image !== undefined)).toBe(true);
    expect(graced.images).toEqual(waited.images);
    expect([late.result.status, late.tab.shots, late.images]).toEqual(["done", 4, Array(4).fill(undefined)]);
    expect(late.requests.map(fingerprint)).toEqual(none.requests.map(fingerprint));
  });

  it("left out under screenshotGraceMs, is still waited for before the page is acted on, shot again or left", async () => {
    const tab = shop();
    tab.shotMs = SHOT_MS;
    // The WAIT's own wait finds no change; the step after's finds the page moved once, so it looks again.
    let waits = 0;
    tab.changed = async () => {
      waits += 1;
      return waits === 2 ? "quiet" : "unchanged";
    };
    const late = await ranOn(tab, { screenshot: "scaled", screenshotGraceMs: SHORT_GRACE_MS });
    expect([late.result.status, late.images, tab.shots]).toEqual(["done", Array(4).fill(undefined), 5]);
    expect([tab.duringShot, tab.capturing]).toEqual([[], 0]);
    // Nor is one left being taken by a run that ends before its first decision: no budget for one.
    const unasked = shop();
    unasked.shotMs = SHOT_MS;
    const decider = {
      ...DEFAULT_PROFILE.decider,
      contextWindow: DEFAULT_PROFILE.decider.maxOutputTokens + TINY_BUDGET,
    };
    const options = { profile: { ...DEFAULT_PROFILE, decider }, screenshotGraceMs: SHORT_GRACE_MS };
    const failed = await ranOn(unasked, { ...options, screenshot: "scaled" });
    expect([failed.result.status, failed.requests.length, unasked.capturing]).toEqual(["failed", 0, 0]);
  });
});

describe("a browser's run, the options left out", () => {
  it("leaves a late screenshot out after 150 ms; screenshotGraceMs 3000 waits for it as before", async () => {
    const slow = () => {
      const tab = shop();
      tab.shotMs = SHOT_MS;
      return tab;
    };
    const left = await browsedOn(slow(), { screenshot: "scaled" });
    const waited = await browsedOn(slow(), { screenshot: "scaled", screenshotGraceMs: 3_000 });
    expect([left.result.status, left.images]).toEqual(["done", Array(4).fill(undefined)]);
    expect([waited.result.status, waited.images.every((image) => image !== undefined)]).toEqual(["done", true]);
  });

  it("asks the tab's history where BACK goes while the page is read; backWithRead false, once it is read", async () => {
    const order = (ran: Ran) => {
      const history = ran.tab.sent.indexOf("Page.getNavigationHistory");
      return history < ran.tab.sent.indexOf("Accessibility.getFullAXTree") ? "while read" : "after read";
    };
    const left = await browsedOn(shop(), { screenshot: "none" });
    const off = await browsedOn(shop(), { screenshot: "none", backWithRead: false });
    expect([left.result.status, order(left)]).toEqual(["done", "while read"]);
    expect([off.result.status, order(off)]).toEqual(["done", "after read"]);
  });
});

describe("where BACK goes", () => {
  it("is asked of the tab's history while the page is read with backWithRead, the steps the same", async () => {
    const after = await ranOn(shop(), { screenshot: "none" });
    const along = await ranOn(shop(), { screenshot: "none", backWithRead: true });
    const order = (ran: Ran) => {
      const history = ran.tab.sent.indexOf("Page.getNavigationHistory");
      return history < ran.tab.sent.indexOf("Accessibility.getFullAXTree") ? "while read" : "after read";
    };
    expect([after.result.status, order(after)]).toEqual(["done", "after read"]);
    expect([along.result.status, order(along)]).toEqual(["done", "while read"]);
    expect(along.requests.map(fingerprint)).toEqual(after.requests.map(fingerprint));
    expect(along.tab.showing).toBe("results");
  });
});
