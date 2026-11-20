import { describe, expect, it } from "vitest";
import * as actions from "../../src/contracts/actions.ts";
import { Texts } from "../../src/contracts/texts.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import type { Element } from "../../src/reading/tree.ts";
import { Acting } from "../../src/run/act.ts";
import { takenOn } from "../../src/run/history.ts";
import { read } from "../../src/run/page.ts";
import type { MadePage } from "./fake.ts";
import { button, captureOf, FakeTab, heading, link, main } from "./fake.ts";

const texts = new Texts(DEFAULT_PROFILE.texts);
const EVENT = "https://parks.test/event?id=7";

/** A calendar whose links and button a click leaves where they are, and the event page one of them points to. */
function calendar(): MadePage {
  const body = [
    main(
      heading("Events"),
      link("Discovery Walk", "event?id=7"),
      link("Write to us", "mailto:parks@example.org"),
      link("Back to the top", "/calendar#top"),
      button("Print"),
    ),
  ];
  return { url: "https://parks.test/calendar", title: "Calendar", body };
}

function event(): MadePage {
  return { url: EVENT, title: "Discovery Walk", body: [main(heading("Discovery Walk"))], firstId: 100 };
}

/** A click on the calendar's element of a name, the page then read in the same state or not. */
async function click(name: string, unchanged = true, edit: (tab: FakeTab, element: Element) => Element = (_, e) => e) {
  const tab = new FakeTab({ start: "calendar", pages: { calendar, event }, click: (on) => on });
  const { tree } = read(captureOf(calendar()), { reading: DEFAULT_PROFILE.reading, secrets: new Set() });
  const element = edit(tab, tree.elements.find((candidate) => candidate.name === name)!);
  const taken = await new Acting(tab.tab, texts).click(element, async () => unchanged);
  return { taken, element, tab };
}

describe("a click on a link that leaves the page as it was", () => {
  it("opens the link's address, resolved against the page's, in the tab: the click led there", async () => {
    const { taken, element, tab } = await click("Discovery Walk");
    expect([tab.navigated, tab.showing]).toEqual([[EVENT], "event"]);
    expect(taken).toEqual(takenOn(actions.CLICK, element));
  });

  it("opens nothing when the page changed, a tab opened or the click did not reach the page", async () => {
    expect((await click("Discovery Walk", false)).tab.navigated).toEqual([]);
    const opening = await click("Discovery Walk", true, (tab, element) => {
      tab.opens = true;
      return element;
    });
    expect(opening.tab.navigated).toEqual([]);
    const changed = await click("Discovery Walk", true, (_, element) => ({ ...element, axName: "Discovery Run" }));
    expect([changed.taken.done, changed.tab.navigated]).toEqual([false, []]);
  });

  it("opens nothing for an address that is no web page's or is the page's own, nor for an element with none", async () => {
    for (const name of ["Write to us", "Back to the top", "Print"]) {
      expect((await click(name)).tab.navigated, name).toEqual([]);
    }
  });
});
