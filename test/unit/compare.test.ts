import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import { Tab } from "../../src/browser/tab.ts";
import type { BrowserOptions, ComparedPage } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";
import type { MadePage } from "./fake.ts";
import { FakeBrowserConnection, FakeTab, heading, MADE_JPEG, main } from "./fake.ts";

const FIRST = "https://homes.test/listing/1";
const SECOND = "https://homes.test/listing/2";
/** An address no page has: the browser cannot resolve it. */
const MISSING = "https://nowhere.test/";
const LOOK_FOR = "$1,250";

function listing(url: string, rent: string): MadePage {
  return { url, title: `Listing ${url.at(-1)}`, body: [main(heading("Two-bedroom flat"), `Rent ${rent} a month`)] };
}

function home(): MadePage {
  return { url: "https://homes.test/", title: "Homes", body: [main(heading("Homes"))] };
}

/** A browser on a made-up one that makes tabs of its own, worked on a made-up tab in front. */
function browserOn(options: BrowserOptions = {}): { browser: Browser; made: FakeBrowserConnection; front: FakeTab } {
  const made = new FakeBrowserConnection([listing(FIRST, "$1,250"), listing(SECOND, "$1,400")]);
  const front = new FakeTab({ start: "home", pages: { home } });
  // The browser as `launch` and `connect` make it, on that tab.
  const make = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
  return { browser: new make(made.connection, front.tab, options), made, front };
}

/** A compare run to its end, the clock moved on as it waits. */
async function compared(browser: Browser, urls: string[], lookFor?: string): Promise<ComparedPage[]> {
  const comparing = browser.compare(urls, lookFor);
  await vi.runAllTimersAsync();
  return comparing;
}

describe("comparing pages", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads each address in a background tab of its own, pictures it, and closes it again", async () => {
    vi.useFakeTimers();
    const { browser, made } = browserOn({ screenshot: "scaled" });
    const pages = await compared(browser, [FIRST, MISSING, SECOND]);
    expect(pages.map(({ url, page, error }) => [url, page?.title, error])).toEqual([
      [FIRST, "Listing 1", undefined],
      [MISSING, undefined, `${MISSING} did not open: net::ERR_NAME_NOT_RESOLVED`],
      [SECOND, "Listing 2", undefined],
    ]);
    expect(pages[0]!.page!.lines.join("\n")).toContain("Rent $1,250 a month");
    expect(pages[2]!.page!.lines.join("\n")).toContain("Rent $1,400 a month");
    expect([...pages[0]!.shot!]).toEqual([...MADE_JPEG]);
    expect(pages[1]!.shot).toBeUndefined();
    const sent = (method: string) => made.sent.filter((command) => command.method === method);
    // All at once: every tab is asked for before any page opens.
    expect(made.sent.slice(0, 3).map(({ method }) => method)).toEqual(Array(3).fill("Target.createTarget"));
    expect(sent("Target.createTarget").map(({ params }) => params)).toEqual([
      { url: "about:blank", background: true },
      { url: "about:blank", background: true },
      { url: "about:blank", background: true },
    ]);
    // Each tab opened its own page, the one the browser could not reach as `open` does: again, twice more.
    expect(sent("Page.navigate").map(({ params, sessionId }) => [sessionId, params.url])).toEqual(
      expect.arrayContaining([
        ["session-made-1", FIRST],
        ["session-made-2", MISSING],
        ["session-made-3", SECOND],
      ]),
    );
    expect(sent("Page.navigate").filter(({ params }) => params.url === MISSING)).toHaveLength(3);
    expect(made.targets.size).toBe(0);
    expect(sent("Target.detachFromTarget")).toHaveLength(3);
    expect(browser.timings().settles.compare?.count).toBe(2);
  });

  it("gives a compared page compareSettleMs to settle, else openSettleMs, else 3.5 s, and a show in it revealSettleMs", async () => {
    vi.useFakeTimers();
    const settles = async (options: BrowserOptions) => {
      const spies = [vi.spyOn(Tab.prototype, "settle"), vi.spyOn(Tab.prototype, "settleOpened")];
      try {
        await compared(browserOn(options).browser, [FIRST], LOOK_FOR);
        return spies.flatMap((spy) => spy.mock.calls.map(([maxMs, kind]) => [maxMs, kind]));
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    };
    expect(await settles({})).toEqual([
      [1_000, undefined],
      [3_500, "compare"],
    ]);
    expect(await settles({ openSettleMs: 2_500 })).toEqual([
      [1_000, undefined],
      [2_500, "compare"],
    ]);
    expect(await settles({ openSettleMs: 2_500, compareSettleMs: 1_500, revealSettleMs: 300 })).toEqual([
      [300, undefined],
      [1_500, "compare"],
    ]);
  });

  it("leaves the tab in front as it was, and brings it to the front again in the end", async () => {
    vi.useFakeTimers();
    const { browser, made, front } = browserOn();
    await compared(browser, [FIRST, SECOND]);
    expect(front.navigated).toEqual([]);
    expect(front.settles).toEqual([]);
    expect(made.sent.some(({ sessionId }) => sessionId === front.sessionId)).toBe(false);
    expect(made.sent.at(-1)).toEqual({
      method: "Target.activateTarget",
      params: { targetId: front.targetId },
      sessionId: undefined,
    });
  });

  it("scrolls each page to the words looked for before it is read and pictured", async () => {
    vi.useFakeTimers();
    const { browser, made } = browserOn();
    await compared(browser, [FIRST, SECOND], LOOK_FOR);
    const revealed = made.sent.filter(
      ({ method, params }) => method === "Runtime.evaluate" && String(params.expression).includes(`"${LOOK_FOR}"`),
    );
    expect(revealed.map(({ sessionId }) => sessionId).sort()).toEqual(["session-made-1", "session-made-2"]);
  });

  it("pictures each page at the browser's own resolution, not scaled down as the decision model's is", async () => {
    vi.useFakeTimers();
    const { browser, made } = browserOn({ screenshot: "scaled" });
    await compared(browser, [FIRST, SECOND]);
    const shots = made.sent.filter(({ method }) => method === "Page.captureScreenshot");
    // The made-up viewport is 1280 pixels wide: the decision model's screenshot would be scaled to 768 of them.
    expect(shots.map(({ params }) => (params.clip as { scale: number }).scale)).toEqual([1, 1]);
  });

  it("takes no picture when screenshots are off", async () => {
    vi.useFakeTimers();
    const { browser, made } = browserOn({ screenshot: "none" });
    const pages = await compared(browser, [FIRST, SECOND]);
    expect(pages.map(({ shot }) => shot)).toEqual([undefined, undefined]);
    expect(made.sent.some(({ method }) => method === "Page.captureScreenshot")).toBe(false);
  });
});
