import { describe, expect, it } from "vitest";
import { Texts } from "../../src/contracts/texts.ts";
import type { Packed, PackInput } from "../../src/decider/pack.ts";
import { pack, packFinalists, TooBig } from "../../src/decider/pack.ts";
import type { PageSteps } from "../../src/decider/request.ts";
import { LOOPING } from "../../src/decider/request.ts";
import { estimate } from "../../src/decider/tokens.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import type { Element, PageTree, TreeLine } from "../../src/reading/tree.ts";
import { Keep } from "../../src/reading/tree.ts";

const NO_STEPS: PageSteps = { scrollDown: false, scrollUp: false, solveCaptcha: false, back: false };

function button(number: number, name: string): Element {
  return {
    number,
    binding: { session: "", target: "", backendNodeId: number },
    role: "button",
    axRole: "button",
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

/** A viewport of `buttons` time slots, a line of text after every fifth. */
function page(buttons: number): PageTree {
  const elements = Array.from({ length: buttons }, (_, n) => button(n + 2, `${(n % 12) + 1}:00 PM Reserve`));
  const lines: TreeLine[] = [];
  elements.forEach((_, index) => {
    lines.push({ line: { kind: "element", element: index }, depth: 0, part: "viewport", parent: undefined });
    if (index % 5 === 4) {
      const text = `Booked ${index} times today`;
      lines.push({ line: { kind: "text", text }, depth: 0, part: "viewport", parent: undefined });
    }
  });
  return {
    url: "https://site.test/restaurant",
    title: "",
    scroll: { top: 0, maxTop: 0 },
    viewport: { x: 0, y: 0, w: 1280, h: 720 },
    elements,
    lines,
    changing: new Set(),
  };
}

function input(tree: PageTree, budget: number, maxChoices: number, more: Partial<PackInput> = {}): PackInput {
  return {
    tree,
    marks: new Map(),
    reading: DEFAULT_PROFILE.reading,
    texts: new Texts(DEFAULT_PROFILE.texts),
    parts: { goal: "Book 7:00 PM", values: [], run: undefined, url: tree.url, title: tree.title },
    actions: [],
    steps: NO_STEPS,
    withheld: new Set(),
    budget,
    maxChoices,
    counter: estimate(3),
    ...more,
  };
}

function one(packing: ReturnType<typeof pack>): Packed {
  if (packing.kind !== "one") throw new Error("one request was expected");
  return packing.packed;
}

function buttonLines(packed: Packed): number {
  return packed.written.lines.filter((line) => line.includes("button")).length;
}

function hasLooping(packed: Packed): boolean {
  return LOOPING in packed.request.questions;
}

describe("packing a step's request", () => {
  it("offers no withheld option, and BACK only when there is somewhere to go", () => {
    const tree = page(3);
    const all = one(pack(input(tree, 100_000, 0))).options;
    expect(all).toContain("CLICK 3");
    expect(all).not.toContain("BACK");
    const some = one(
      pack(input(tree, 100_000, 0, { steps: { ...NO_STEPS, back: true }, withheld: new Set(["CLICK 3"]) })),
    );
    expect(some.options).not.toContain("CLICK 3");
    expect(some.options).toContain("CLICK 4");
    expect(some.options.slice(-8)).toEqual([
      "BACK",
      "NEEDS_FROM_PERSON",
      "NEEDS_APPROVAL",
      "SITE_CANNOT",
      "BLOCKED",
      "PAGE_UNUSABLE",
      "OTHER_FAILURE",
      "DONE",
    ]);
  });

  it("writes whole a viewport one request holds", () => {
    const packed = one(pack(input(page(12), 30_000, 255)));
    expect([buttonLines(packed), packed.elements, packed.cut, packed.round.kind]).toEqual([12, 12, false, "whole"]);
    expect(packed.written.lines.some((line) => line.includes("Booked 9 times today"))).toBe(true);
    expect(hasLooping(packed)).toBe(true);
  });

  it("asks a viewport past the option limit in groups, then its finalists", () => {
    const tree = page(40);
    const packing = pack(input(tree, 30_000, 25));
    if (packing.kind !== "groups") throw new Error("groups were expected");
    const { groups, room } = packing;
    expect(room).toBe(25 - (groups[0]!.options.length - groups[0]!.elements));
    expect(groups.length).toBe(Math.ceil(40 / room));
    expect(new Set(groups.flatMap((group) => group.options.slice(0, group.elements))).size).toBe(40);
    groups.forEach((group, n) => {
      expect(group.options.length).toBeLessThanOrEqual(25);
      expect(group.round).toEqual({ kind: "group", n: n + 1, of: groups.length });
      // The viewport whole around the group's own options; a group asks its step alone.
      expect([buttonLines(group), group.cut, hasLooping(group)]).toEqual([40, false, false]);
    });
    const finals = packFinalists(input(tree, 30_000, 25), ["CLICK 30", "CLICK 3"], 2);
    expect(buttonLines(finals)).toBe(40);
    expect(finals.options.slice(0, finals.elements)).toEqual(["CLICK 3", "CLICK 30"]);
    expect(finals.round).toEqual({ kind: "finalists", of: 2 });
  });

  it("drops the least likely finalists first when the budget does not hold them", () => {
    const tree = page(40);
    const ranked = Array.from({ length: 40 }, (_, n) => `CLICK ${41 - n}`);
    const all = packFinalists(input(tree, 1_000_000, 0), ranked, 2);
    const fewer = packFinalists(input(tree, Math.floor((all.tokens * 3) / 4), 0), ranked, 2);
    expect(fewer.elements).toBeGreaterThan(0);
    expect(fewer.elements).toBeLessThan(40);
    expect(fewer.options).toContain("CLICK 41");
    expect(fewer.options).not.toContain("CLICK 2");
    expect(() => packFinalists(input(tree, 50, 0), ranked, 2)).toThrow(TooBig);
  });

  it("asks a viewport past the budget in groups, each within it", () => {
    const tree = page(60);
    const budget = Math.floor((one(pack(input(tree, 1_000_000, 255))).tokens * 2) / 3);
    const packing = pack(input(tree, budget, 255));
    if (packing.kind !== "groups") throw new Error("groups were expected");
    expect(packing.groups.length).toBeGreaterThanOrEqual(2);
    expect(packing.groups.every((group) => group.tokens <= budget)).toBe(true);
    expect(packing.groups.reduce((total, group) => total + buttonLines(group), 0)).toBe(60);
  });
});
