import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import type { Tab } from "../../src/browser/tab.ts";
import type { BrowserOptions } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";
import type { MadePage } from "./fake.ts";
import { FakeTab, fingerprint, heading, main, scripted } from "./fake.ts";

const ADDRESS = "https://parks.test/event";

function home(): MadePage {
  return { url: "https://parks.test/", title: "Parks", body: [main(heading("Parks"))] };
}

function event(): MadePage {
  const body = [main(heading("Discovery Walk"), "Meet in front of the museum.")];
  return { url: ADDRESS, title: "Discovery Walk", body, firstId: 100 };
}

/** A browser on a made-up tab, its first navigations answered with `refusals` (the browser's `errorText`s). */
function browserOn(refusals: string[], options: BrowserOptions = {}): { browser: Browser; tab: FakeTab } {
  const tab = new FakeTab({ start: "home", pages: { home, event } });
  tab.refusals.push(...refusals);
  // The browser as `launch` and `connect` make it, on that tab.
  const made = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
  return { browser: new made({} as Connection, tab.tab, options), tab };
}

/** The request a run asks on the event's page opened after `refusals`, the clock held still but for the waits. */
async function askedOn(refusals: string[]): Promise<object> {
  const decider = scripted(() => "DONE");
  const { browser } = browserOn(refusals, { decider, screenshot: "none" });
  vi.useFakeTimers();
  const opened = browser.open(ADDRESS);
  await vi.runAllTimersAsync();
  await opened;
  expect((await browser.run({ goal: "Find where the Discovery Walk meets" })).status).toBe("done");
  return fingerprint(decider.requests[0]!);
}

describe("opening an address", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens it again after a network error, two more times at most, a moment apart", async () => {
    vi.useFakeTimers();
    const { browser, tab } = browserOn(["net::ERR_CONNECTION_RESET", "net::ERR_NAME_NOT_RESOLVED"]);
    const opened = browser.open(ADDRESS);
    await vi.runAllTimersAsync();
    await opened;
    expect([tab.navigated, tab.showing]).toEqual([[ADDRESS, ADDRESS, ADDRESS], "event"]);
  });

  it("fails as before when the last try does not reach it either, and at once for an error no network's", async () => {
    vi.useFakeTimers();
    const errors = ["net::ERR_INTERNET_DISCONNECTED", "net::ERR_TIMED_OUT", "net::ERR_CONNECTION_REFUSED"];
    const unreached = browserOn(errors);
    const failed = expect(unreached.browser.open(ADDRESS)).rejects.toThrow(`${ADDRESS} did not open: ${errors[2]}`);
    await vi.runAllTimersAsync();
    await failed;
    expect(unreached.tab.navigated.length).toBe(3);
    for (const refusal of ["net::ERR_ABORTED", "net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_BLOCKED_BY_CLIENT"]) {
      const { browser, tab } = browserOn([refusal]);
      await expect(browser.open(ADDRESS)).rejects.toThrow(`${ADDRESS} did not open: ${refusal}`);
      expect(tab.navigated.length, refusal).toBe(1);
    }
  });

  it("settles the page as an action's settle does, for 3.5 s at most with the fast settle, unless the options say otherwise", async () => {
    const settled = async (options: BrowserOptions) => {
      const { browser, tab } = browserOn([], options);
      await browser.open(ADDRESS);
      return tab.settles;
    };
    expect(await settled({})).toEqual([["settleOpened", 3_500, "open"]]);
    expect(await settled({ fastOpenSettle: false })).toEqual([["settle", 3_500, "open"]]);
    expect(await settled({ fastOpenSettle: false, openSettleMs: 6_000 })).toEqual([["settle", 6_000, "open"]]);
    expect(await settled({ openSettleMs: 2_500 })).toEqual([["settleOpened", 2_500, "open"]]);
  });

  it("packs the request the base code packed, on a page opened at the first try", async () => {
    expect(await askedOn([])).toMatchSnapshot();
  });

  it("packs that request on a page opened again after a network error", async () => {
    expect(await askedOn(["net::ERR_NETWORK_CHANGED"])).toEqual(await askedOn([]));
  });
});
