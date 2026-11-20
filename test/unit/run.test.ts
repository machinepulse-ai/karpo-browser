import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import type { Tab } from "../../src/browser/tab.ts";
import type { Decider, DecisionRequest } from "../../src/decider/systemone.ts";
import type { BrowserOptions } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import type { RunResult, StepRecord } from "../../src/run/run.ts";
import { run } from "../../src/run/run.ts";
import type { Asked, MadePage, Site } from "./fake.ts";
import { button, deals, FakeTab, fingerprint, heading, link, main, pagesOf, scripted } from "./fake.ts";

/** How a run on a made-up site ended, every request it asked, and its tab. */
interface Ran {
  result: RunResult;
  requests: DecisionRequest[];
  tab: FakeTab;
}

/** A run on a made-up site, its clock held still. */
async function runOn(site: Site, goal: string, step: (asked: Asked) => string): Promise<Ran> {
  const tab = new FakeTab(site);
  const decider = scripted(step);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const result = await run(pagesOf(tab), { goal }, { profile: DEFAULT_PROFILE, decider, screenshot: "none" });
    return { result, requests: decider.requests, tab };
  } finally {
    vi.useRealTimers();
  }
}

/** Results worked through one by one: a list, an item, back, the next item. */
const SHOP = "https://shop.test";
const ITEMS = ["Trail runner", "Road racer", "Hiking boot", "Court classic"];

function results(): MadePage {
  const links = ITEMS.map((name, at) => link(name, `/item/${at + 1}`));
  return { url: `${SHOP}/results`, title: "Results", body: [main(heading(`${ITEMS.length} results`), ...links)] };
}

function item(at: number): MadePage {
  const name = ITEMS[at]!;
  const body = [main(heading(name), `Price $${40 + at}`, button("Add to cart"))];
  return { url: `${SHOP}/item/${at + 1}`, title: name, body, firstId: 100 * (at + 1) };
}

const SHOP_SITE: Site = {
  start: "results",
  pages: { results, ...Object.fromEntries(ITEMS.map((_, at) => [`item ${at + 1}`, () => item(at)])) },
};

/** Opens each item in turn and goes back to the list, then is done. */
function browsing(): (asked: Asked) => string {
  let opened = 0;
  return (page) => {
    if (page.has("button Add to cart")) return "BACK";
    if (opened === ITEMS.length) return "DONE";
    opened += 1;
    return `CLICK ${page.numberOf(`link ${ITEMS[opened - 1]}`)}`;
  };
}

/** A time picker opened, closed and a time clicked, over and over, the page as it was. */
const PICKER: MadePage = {
  url: "https://park.test/search",
  title: "Parking",
  body: [main(heading("Find parking"), button("ARRIVE AFTER"), button("CLOSE"), button("| 8:30 am"))],
};
const PICKER_SITE: Site = { start: "picker", pages: { picker: () => PICKER }, click: () => "picker" };
const PICKER_ROUND = ["ARRIVE AFTER", "CLOSE", "| 8:30 am"];
/** How many steps the picker's run takes before it is done, when nothing stops it before. */
const PICKER_STEPS = 12;

function picking(): (asked: Asked) => string {
  let taken = 0;
  return (page) => {
    taken += 1;
    return taken > PICKER_STEPS ? "DONE" : `CLICK ${page.numberOf(`button ${PICKER_ROUND[(taken - 1) % 3]}`)}`;
  };
}

/** Sizes shown and hidden again and again while the page's carousel turns and its timer ticks. */
const DEALS_SITE: Site = {
  start: "hidden",
  pages: { hidden: (reading) => deals(reading, false), shown: (reading) => deals(reading, true) },
  click: (on, element) => (element.name === "Show sizes" ? "shown" : element.name === "Hide sizes" ? "hidden" : on),
};
/** How many steps the deals page's run takes before it is done, when nothing stops it before. */
const DEALS_STEPS = 12;

function toggling(): (asked: Asked) => string {
  let taken = 0;
  return (page) => {
    taken += 1;
    if (taken > DEALS_STEPS) return "DONE";
    return `CLICK ${page.numberOf(page.has("button Show sizes") ? "button Show sizes" : "button Hide sizes")}`;
  };
}

/** A calendar's event link; its address holds the event's id in its query. */
const EVENT_ADDRESS = "https://parks.test/event-details.htm?id=DCA5F797";

function calendar(): MadePage {
  const event = link("Discovery Walk Sat, Nov 21", "event-details.htm?id=DCA5F797");
  return { url: "https://parks.test/calendar", title: "Calendar", body: [main(heading("Events"), event)] };
}

function event(): MadePage {
  const body = [main(heading("Discovery Walk"), "Meet in front of the museum.")];
  return { url: EVENT_ADDRESS, title: "Discovery Walk", body, firstId: 100 };
}

/** The calendar's site: its link leads to the event, or (`dead`) a click on it leaves the page as it was. */
function events(dead: boolean): Site {
  return { start: "calendar", pages: { calendar, event }, ...(dead ? { click: (on: string) => on } : {}) };
}

/** Clicks the event's link until the event's page shows, then is done. */
function attending(asked: Asked): string {
  return asked.has("Meet in front") ? "DONE" : `CLICK ${asked.numberOf("link Discovery Walk")}`;
}

describe("a run that works through a list, an item at a time", () => {
  let ran: Ran;
  beforeAll(async () => {
    ran = await runOn(SHOP_SITE, "Find the cheapest shoe", browsing());
  });
  /** The requests the code before asked: it ended going in circles as it asked the seventh, back at the list a third time. */
  const BEFORE = 7;

  it("packs the requests the base code packed", () => {
    const { requests } = ran;
    expect(requests.slice(0, BEFORE).map(fingerprint)).toMatchSnapshot();
  });

  it("is not taken for going in circles: each item was new", () => {
    const { result, requests } = ran;
    expect([result.status, requests.length]).toEqual(["done", 2 * ITEMS.length + 1]);
  });
});

describe("a run that repeats a round of steps on a page that does not change", () => {
  let ran: Ran;
  beforeAll(async () => {
    ran = await runOn(PICKER_SITE, "Park after 8:30 am", picking());
  });
  /** The requests the code before asked: it ended at the fourth, each click a coming back to the page as it was. */
  const BEFORE = 4;

  it("packs the requests the base code packed", () => {
    const { requests } = ran;
    expect(requests.slice(0, BEFORE).map(fingerprint)).toMatchSnapshot();
  });

  it("ends going in circles once the round of three is taken twice", () => {
    const { result, requests } = ran;
    expect([result.status, result.detail, requests.length]).toEqual([
      "looping",
      "the same 3 steps taken 2 times in a row",
      6,
    ]);
  });
});

describe("a run that shows and hides the same list while its page changes by itself", () => {
  let ran: Ran;
  beforeAll(async () => {
    ran = await runOn(DEALS_SITE, "Find the sizes of the trail shoe", toggling());
  });
  /** The requests the run asks: the code before asked them and went on to the end, the page new at every reading. */
  const ASKED = 6;

  it("packs the requests the base code packed", () => {
    expect(ran.requests.slice(0, ASKED).map(fingerprint)).toMatchSnapshot();
  });

  it("ends going in circles: a carousel turning and a timer ticking are no progress", () => {
    const { result, requests } = ran;
    expect([result.status, result.detail, requests.length]).toEqual([
      "looping",
      "back at the same page state 3 times",
      ASKED,
    ]);
  });
});

describe("a run whose click on a link leaves the page as it was", () => {
  let working: Ran;
  let dead: Ran;
  beforeAll(async () => {
    working = await runOn(events(false), "Find where the Discovery Walk meets", attending);
    dead = await runOn(events(true), "Find where the Discovery Walk meets", attending);
  });

  it("packs the requests the base code packed for a link that works", () => {
    expect([working.result.status, working.requests.length]).toEqual(["done", 2]);
    expect(working.requests.map(fingerprint)).toMatchSnapshot();
  });

  it("opens the link's address, and reads as a click on a link that works", () => {
    expect([dead.result.status, dead.tab.navigated]).toEqual(["done", [EVENT_ADDRESS]]);
    expect(dead.requests.map(fingerprint)).toEqual(working.requests.map(fingerprint));
    expect((dead.requests[1]!.state as { recent_actions: string }).recent_actions).toBe(
      "CLICK link Discovery Walk Sat, Nov 21\n  page → parks.test/event-details.htm?id=DCA5F797",
    );
  });
});

describe("a run's steps as they are heard", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
  const READABLE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  /** A tab whose viewport's screenshot is JPEG, READABLE when asked wider than the model's; the widths asked. */
  class Shooting extends FakeTab {
    readonly widths: (number | undefined)[] = [];
    override async viewportJpeg(
      _quality?: number,
      width?: number,
    ): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
      this.widths.push(width);
      return width === 768 ? { jpeg: JPEG, width: 768, height: 432 } : { jpeg: READABLE, width: 1280, height: 720 };
    }
  }

  /**
   * The steps of a run on the calendar's site as heard, the screenshots its questions carried, and how many readable
   * screenshots were being taken as each question was asked.
   */
  const heard = async (screenshot: "scaled" | "none", readable?: () => Promise<Uint8Array | undefined>) => {
    const steps: StepRecord[] = [];
    const carried: unknown[] = [];
    const taking: number[] = [];
    let taken = 0;
    const answers = scripted(attending);
    const decider: Decider = {
      ask: (request, context) => {
        carried.push(context.image);
        taking.push(taken);
        return answers.ask(request, context);
      },
    };
    const onStep = (step: StepRecord) => steps.push(step);
    const readableScreenshot = readable
      ? () => {
          taken++;
          return readable();
        }
      : undefined;
    const options = { profile: DEFAULT_PROFILE, decider, screenshot, onStep, readableScreenshot };
    await run(pagesOf(new Shooting(events(false))), { goal: "Find where the Discovery Walk meets" }, options);
    return { steps, carried, taking };
  };

  it("carry the viewport as a person can read it, taken while the model decides, only when asked", async () => {
    const shot = await heard("scaled", async () => READABLE);
    expect(shot.steps.map((step) => step.readableScreenshot)).toEqual([READABLE, READABLE]);
    expect(shot.taking).toEqual([1, 2]);
    // The model's own question carries its own screenshot, as without.
    const part = {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}` },
    };
    expect(shot.carried).toEqual([part, part]);
    const plain = await heard("scaled");
    expect(plain.steps.map((step) => "readableScreenshot" in step)).toEqual([false, false]);
    expect(plain.carried).toEqual([part, part]);
  });

  it("carry none where the step's question carried none, or the screenshot failed, and the run goes on", async () => {
    const none = await heard("none", async () => READABLE);
    expect(none.steps.map((step) => "readableScreenshot" in step)).toEqual([false, false]);
    expect(none.taking).toEqual([0, 0]);
    const failing = await heard("scaled", async () => {
      throw new Error("no screenshot");
    });
    expect(failing.steps.map((step) => [step.key.split(" ")[0], "readableScreenshot" in step])).toEqual([
      ["CLICK", false],
      ["DONE", false],
    ]);
  });

  it("carry it from a browser asked to (readableStepShots), as wide as its readableScreenshot", async () => {
    const steps = async (options: BrowserOptions) => {
      const tab = new Shooting(events(false));
      const made = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
      const browser = new made({} as Connection, tab.tab, { decider: scripted(attending), ...options });
      const heard: StepRecord[] = [];
      await browser.run({ goal: "Find where the Discovery Walk meets" }, { onStep: (step) => heard.push(step) });
      return { readable: heard.map((step) => step.readableScreenshot), widths: tab.widths };
    };
    expect(await steps({ screenshot: "scaled", readableStepShots: true })).toEqual({
      readable: [READABLE, READABLE],
      widths: [768, 1_600, 768, 1_600],
    });
    expect(await steps({ screenshot: "scaled" })).toEqual({ readable: [undefined, undefined], widths: [768, 768] });
  });
});
