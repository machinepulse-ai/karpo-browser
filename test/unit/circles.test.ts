import { describe, expect, it } from "vitest";
import * as actions from "../../src/contracts/actions.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import type { Element, PageTree, TreeLine } from "../../src/reading/tree.ts";
import { Keep } from "../../src/reading/tree.ts";
import { Circles } from "../../src/run/circles.ts";
import type { Taken } from "../../src/run/history.ts";
import { takenOn, takenOnPage } from "../../src/run/history.ts";
import type { Reading } from "../../src/run/page.ts";
import { read } from "../../src/run/page.ts";
import { captureOf, deals } from "./fake.ts";

function element(number: number, role: string, name: string): Element {
  return {
    number,
    binding: { session: "", target: "", backendNodeId: number },
    role,
    axRole: role,
    axName: name,
    name,
    states: [],
    value: undefined,
    secretLength: undefined,
    href: undefined,
    clickable: false,
    pointer: false,
    words: false,
    disabled: false,
    kind: { kind: "click" },
    keep: Keep.Clickable,
    part: "viewport",
    rect: { x: 0, y: 0, w: 10, h: 10 },
  };
}

/** A page of elements, lines of text after them. */
function page(elements: Element[], texts: string[] = []): PageTree {
  const line = (of: TreeLine["line"]): TreeLine => ({ line: of, depth: 0, part: "viewport", parent: undefined });
  return {
    url: "https://site.test/",
    title: "",
    scroll: { top: 0, maxTop: 0 },
    viewport: { x: 0, y: 0, w: 1280, h: 720 },
    elements,
    lines: [
      ...elements.map((_, index) => line({ kind: "element", element: index })),
      ...texts.map((text) => line({ kind: "text", text })),
    ],
    changing: new Set(),
  };
}

/** A page read in a page state of a test's naming, nothing on it changing by itself. */
function reading(state: string, tree: PageTree): Reading {
  return { tree, state, steady: state };
}

/** A run as the circles take it: a page read, then each step taken on the page read last and the page read after it. */
function replay(circles: Circles, first: Reading, steps: readonly (readonly [Taken, Reading])[]): void {
  circles.read(first);
  let on = first;
  for (const [taken, after] of steps) {
    circles.took(taken, on, after);
    circles.read(after);
    on = after;
  }
}

const back = takenOnPage(actions.BACK);
const click = (tree: PageTree, at: number) => takenOn(actions.CLICK, tree.elements[at]!);

describe("a page state come back to", () => {
  it("counts no return to a list past an item new to the run: each item is getting on", () => {
    const list = page([element(2, "link", "Trail runner"), element(3, "link", "Road racer")]);
    const item = (name: string) => page([element(9, "button", "Add to cart")], [name]);
    const results = reading("results", list);
    const [trail, road] = [reading("trail", item("Trail runner $40")), reading("road", item("Road racer $41"))];
    const circles = new Circles();
    replay(circles, results, [
      [click(list, 0), trail],
      [back, results],
      [click(list, 1), road],
      [back, results],
    ]);
    expect([circles.arrivals(results), circles.arrivals(trail), circles.arrivals(road)]).toEqual([0, 1, 1]);
    // The first item again: the list then comes back with nothing new since the run was last there; the item comes
    // past the second one, new since the run was last on it.
    replay(circles, results, [
      [click(list, 0), trail],
      [back, results],
    ]);
    expect([circles.arrivals(results), circles.arrivals(trail)]).toEqual([1, 1]);
    replay(circles, results, [[click(list, 0), trail]]);
    expect(circles.arrivals(trail)).toBe(2);
  });

  it("counts every return between two pages with nothing new between them, but the first past a page new then", () => {
    const tree = page([element(1, "link", "Next"), element(2, "link", "Back")]);
    const [a, b] = [reading("a", tree), reading("b", tree)];
    const [next, previous] = [click(tree, 0), click(tree, 1)];
    const circles = new Circles();
    replay(circles, a, [
      [next, b],
      [previous, a],
      [next, b],
      [previous, a],
      [next, b],
    ]);
    expect([circles.arrivals(b), circles.arrivals(a)]).toEqual([3, 1]);
  });

  it("is progress when the page shows words new to the run, its state seen before or not", () => {
    const list = page([element(2, "link", "Reviews")]);
    const shown = (texts: string[]) => reading("reviews", page([element(9, "link", "Back")], texts));
    const results = reading("results", list);
    const circles = new Circles();
    replay(circles, results, [
      [click(list, 0), shown(["4.5 stars"])],
      [back, results],
      [click(list, 0), shown(["4.5 stars", "Great grip on wet rock"])],
      [back, results],
    ]);
    // The reviews counted twice; the list's last return came past words new to the run.
    expect([circles.arrivals(shown([])), circles.arrivals(results)]).toEqual([2, 0]);
  });

  it("counts a step that changed nothing only when it repeats one taken since the page came to its state", () => {
    const tree = page([
      element(5, "button", "ARRIVE AFTER"),
      element(6, "button", "CLOSE"),
      element(7, "button", "Go"),
    ]);
    const picker = reading("picker", tree);
    const circles = new Circles();
    replay(circles, picker, [
      [click(tree, 0), picker],
      [click(tree, 1), picker],
      [click(tree, 2), picker],
    ]);
    expect(circles.arrivals(picker)).toBe(0);
    replay(circles, picker, [[click(tree, 0), picker]]);
    expect(circles.arrivals(picker)).toBe(1);
    // A box filled with the same value again and again, the page as it was after the first.
    const empty = page([element(10, "searchbox", "Search")]);
    const fill = { ...takenOn(actions.FILL, empty.elements[0]!), argument: "1" };
    const [home, typed] = [reading("home", empty), reading("typed", page([element(10, "searchbox", "Search")], ["x"]))];
    const filling = new Circles();
    replay(filling, home, [
      [fill, typed],
      [fill, typed],
      [fill, typed],
    ]);
    expect(filling.arrivals(typed)).toBe(3);
  });

  it("counts no step that did not reach the page, nor a scroll", () => {
    const tree = page([element(4, "button", "Book")]);
    const [on, scrolled] = [reading("on", tree), reading("scrolled", tree)];
    const refused = { ...click(tree, 0), note: "covered by dialog Cookies", done: false };
    const scroll = takenOnPage(actions.SCROLL_DOWN);
    const circles = new Circles();
    replay(circles, on, [
      [refused, on],
      [refused, on],
      [scroll, scrolled],
      [scroll, on],
      [scroll, on],
    ]);
    expect([circles.arrivals(on), circles.arrivals(scrolled)]).toEqual([0, 0]);
  });
});

describe("a round of steps", () => {
  it("goes in circles when a dialog opened and closed again and again shows nothing new", () => {
    const product = page([element(4, "button", "Specs and Compatibility")]);
    const dialog = page([element(4, "button", "Specs and Compatibility"), element(9, "button", "Close")], ["Warranty"]);
    const [closed, open] = [reading("closed", product), reading("open", dialog)];
    const [specs, close] = [click(product, 0), click(dialog, 1)];
    const circles = new Circles();
    replay(circles, closed, [
      [specs, open],
      [close, closed],
      [specs, open],
    ]);
    expect(circles.round(dialog, "CLICK 9")).toBeUndefined();
    replay(circles, open, [
      [close, closed],
      [specs, open],
    ]);
    expect(circles.round(dialog, "CLICK 9")).toEqual({ steps: 2, rounds: 3 });
    // Another step chosen breaks the round: the run is getting out of it.
    expect(circles.round(dialog, "SCROLL_DOWN 1")).toBeUndefined();
  });

  it("goes in circles when a round of three or four steps is taken twice", () => {
    const picker = page([
      element(5, "button", "ARRIVE AFTER"),
      element(6, "div", "CLOSE"),
      element(7, "div", "8:30 am"),
    ]);
    const on = reading("picker", picker);
    const [arrive, close, time] = [0, 1, 2].map((at) => click(picker, at)) as [Taken, Taken, Taken];
    const threes = new Circles();
    replay(threes, on, [
      [arrive, on],
      [close, on],
      [time, on],
      [arrive, on],
      [close, on],
    ]);
    expect(threes.round(picker, "CLICK 7")).toEqual({ steps: 3, rounds: 2 });
    // A search engine asked for the same words again and again.
    const google = page([element(10, "combobox", "Search"), element(11, "button", "Clear")]);
    const results = reading("results", google);
    const fill = { ...takenOn(actions.FILL, google.elements[0]!), argument: "1" };
    const round = [
      fill,
      takenOn(actions.PRESS_ENTER, google.elements[0]!),
      click(google, 1),
      takenOnPage(actions.SCROLL_DOWN),
    ];
    const fours = new Circles();
    replay(
      fours,
      results,
      [...round, ...round.slice(0, 3)].map((taken) => [taken, results] as const),
    );
    expect(fours.round(google, "SCROLL_DOWN 1")).toEqual({ steps: 4, rounds: 2 });
  });

  it("is no circle while the pages show words new to the run; the same item again and again is", () => {
    const same = page([element(30, "link", "View details"), element(31, "link", "View details")]);
    const listed = reading("listed", same);
    const item = (name: string) => reading(name, page([element(40, "button", "Add to cart")], [name]));
    const [first, second] = [item("Michelin Defender $189"), item("Goodyear Assurance $142")];
    const circles = new Circles();
    replay(circles, listed, [
      [click(same, 0), first],
      [back, listed],
      [click(same, 1), second],
      [back, listed],
      [click(same, 0), first],
    ]);
    // Links of one name, each item's page its own words: getting on.
    expect(circles.round(first.tree, "BACK")).toBeUndefined();
    replay(circles, first, [
      [back, listed],
      [click(same, 0), first],
      [back, listed],
      [click(same, 0), first],
    ]);
    expect(circles.round(first.tree, "BACK")).toEqual({ steps: 2, rounds: 3 });
    // More results each time: a list growing shows words new to the run.
    const more = (n: number) =>
      reading(
        `more ${n}`,
        page([
          element(50, "button", "Show more"),
          ...Array.from({ length: n }, (_, at) => element(60 + at, "link", `Result ${at}`)),
        ]),
      );
    const [ten, twenty, thirty, forty] = [more(10), more(20), more(30), more(40)];
    const show = click(ten.tree, 0);
    const scroll = takenOnPage(actions.SCROLL_DOWN);
    const growing = new Circles();
    replay(growing, ten, [
      [show, twenty],
      [scroll, twenty],
      [show, thirty],
      [scroll, thirty],
      [show, forty],
    ]);
    expect(growing.round(forty.tree, "SCROLL_DOWN 1")).toBeUndefined();
  });

  it("takes a carousel turning and a timer ticking for no progress, and their words for none new", () => {
    const options = { reading: DEFAULT_PROFILE.reading, secrets: new Set<string>() };
    const pages = [0, 1, 2, 3, 4, 5].map((at) => read(captureOf(deals(at, at % 2 === 1)), options));
    const named = (at: number, name: string) => pages[at]!.tree.elements.find((element) => element.name === name)!;
    const [show, hide] = [
      takenOn(actions.CLICK, named(0, "Show sizes")),
      takenOn(actions.CLICK, named(1, "Hide sizes")),
    ];
    const circles = new Circles();
    replay(circles, pages[0]!, [
      [show, pages[1]!],
      [hide, pages[2]!],
      [show, pages[3]!],
      [hide, pages[4]!],
      [show, pages[5]!],
    ]);
    expect(circles.arrivals(pages[5]!)).toBe(3);
    expect(circles.round(pages[5]!.tree, `CLICK ${named(5, "Hide sizes").number}`)).toEqual({ steps: 2, rounds: 3 });
  });

  it("is no round when one step is taken again and again", () => {
    const calendar = page([element(70, "button", "Next month"), element(71, "button", "18")]);
    const on = reading("calendar", calendar);
    const circles = new Circles();
    replay(
      circles,
      on,
      Array.from({ length: 7 }, () => [click(calendar, 0), on] as const),
    );
    expect(circles.round(calendar, "CLICK 70")).toBeUndefined();
  });
});
