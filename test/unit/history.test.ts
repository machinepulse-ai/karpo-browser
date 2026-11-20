import { describe, expect, it } from "vitest";
import * as actions from "../../src/contracts/actions.ts";
import { Texts } from "../../src/contracts/texts.ts";
import { stateOf } from "../../src/reading/state.ts";
import type { Element, PageTree } from "../../src/reading/tree.ts";
import { Keep } from "../../src/reading/tree.ts";
import { History, takenOn, takenOnPage } from "../../src/run/history.ts";
import type { Reading } from "../../src/run/page.ts";

const texts = new Texts({
  "effect.no_change": "the page did not change",
  "page.tried": "tried here {{n}} times: {{result}}",
});

function element(node: number, role: string, name: string, value?: string): Element {
  return {
    number: node,
    binding: { session: "", target: "", backendNodeId: node },
    role,
    axRole: role,
    axName: name,
    name,
    states: [],
    value,
    secretLength: undefined,
    href: undefined,
    clickable: false,
    pointer: false,
    words: false,
    disabled: false,
    kind: value === undefined ? { kind: "click" } : { kind: "input", readonly: false },
    keep: Keep.Clickable,
    part: "viewport",
    rect: { x: 0, y: 0, w: 10, h: 10 },
  };
}

function page(elements: Element[], scrollTop = 0): Reading {
  const tree: PageTree = {
    url: "https://site.test/events",
    title: "",
    scroll: { top: scrollTop, maxTop: 2400 },
    viewport: { x: 0, y: 0, w: 1280, h: 720 },
    elements,
    lines: elements.map((_, index) => ({
      line: { kind: "element", element: index },
      depth: 0,
      part: "viewport",
      parent: undefined,
    })),
    changing: new Set(),
  };
  const state = stateOf(tree);
  return { tree, state, steady: state };
}

/** The lines the history writes for one action between two readings, as the page after numbers its elements. */
function lines(taken: ReturnType<typeof takenOnPage>, before: Reading, after: Reading): string {
  const history = new History();
  history.read(before);
  history.took(taken, before, after, texts);
  return history.recent(after.tree, 1, texts)[0]!;
}

describe("the run's history", () => {
  it("a page drawn anew shows only what changed", () => {
    const before = page([element(1, "button", "4"), element(2, "button", "5"), element(3, "textbox", "Guests", "1")]);
    // Every node is new: the calendar and the box were drawn again, and the day's times came.
    const after = page([
      element(11, "button", "4"),
      element(12, "button", "5"),
      element(13, "textbox", "Guests", "2"),
      element(14, "button", "7:30 PM"),
    ]);
    expect(lines(takenOn(actions.CLICK, before.tree.elements[1]!), before, after)).toBe(
      "CLICK button 5\n  13 [value: 1 → 2]\n  + 14 button 7:30 PM",
    );
  });

  it("an element still on the page pairs with itself first", () => {
    // Two boxes of the same name swap places: each keeps its node, so neither changed.
    const before = page([element(1, "textbox", "Quantity", "1"), element(2, "textbox", "Quantity", "2")]);
    const after = page([element(2, "textbox", "Quantity", "2"), element(1, "textbox", "Quantity", "1")]);
    expect(lines(takenOnPage(actions.WAIT), before, after)).toBe("WAIT\n  → the page did not change");
  });

  it("elements of the same name pair in page order", () => {
    const before = page([element(1, "button", "Reserve"), element(2, "button", "Reserve")]);
    const after = page([element(11, "button", "Reserve")]);
    expect(lines(takenOnPage(actions.WAIT), before, after)).toBe("WAIT\n  - button Reserve");
  });

  it("a run's result names the value and the page where the model reads numbers", () => {
    const email = element(3, "textbox", "Email", "");
    const before = page([email]);
    const after = page([element(3, "textbox", "Email", "ann@example.com")], 600);
    const history = new History();
    history.read(before);
    history.took({ ...takenOn(actions.FILL, email), argument: "2", value: "email" }, before, after, texts);
    history.took(takenOnPage(actions.SCROLL_DOWN), page([email], 0), after, texts);
    expect(history.recent(after.tree, 2, texts)[0]).toBe('FILL 3 2\n  3 [value: "" → ann@example.com]');
    expect(history.latest(2).lines(undefined, texts)).toEqual([
      'FILL textbox Email ← email\n  textbox Email [value: "" → ann@example.com]',
      'SCROLL_DOWN page\n  page [scrolled: 0 → 600/2400px]\n  textbox Email [value: "" → ann@example.com]',
    ]);
  });

  it("marks what was tried in a page state the run came back to", () => {
    const reading = page([element(1, "button", "Next")]);
    const history = new History();
    history.read(reading);
    history.took(takenOn(actions.CLICK, reading.tree.elements[0]!), reading, reading, texts);
    expect(history.marks(reading, texts).size).toBe(0);
    history.read(reading);
    expect(history.marks(reading, texts).get(0)).toBe("tried here 1 times: → the page did not change");
    expect(history.summary(reading, 12.4)).toMatchObject({
      seconds: 12,
      page_state_seen: 2,
      actions_without_change_in_a_row: 1,
    });
  });
});
