import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import { revealScript } from "../../src/browser/reveal.ts";
import type { Tab } from "../../src/browser/tab.ts";
import type { BrowserOptions } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";

/** The box a drawn element has; one not drawn has none. */
const BOX = { width: 300, height: 20 };
const NO_BOX = { width: 0, height: 0 };
/** What a tree walker is asked to walk: text nodes. */
const SHOW_TEXT = 4;

/** A run of text of a made-up page. */
class Words {
  parentElement: Element | null = null;
  readonly textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

/**
 * An element of a made-up page: its children, whether it is drawn, how many times it was scrolled to, and how it was
 * asked to be scrolled the last time.
 */
class Element {
  parentElement: Element | null = null;
  readonly tag: string;
  readonly children: (Element | Words)[];
  readonly drawn: boolean;
  scrolls = 0;
  scrolledWith: unknown;

  constructor(tag: string, children: (Element | string)[], drawn = true) {
    this.tag = tag;
    this.children = children.map((child) => (typeof child === "string" ? new Words(child) : child));
    this.drawn = drawn;
    for (const child of this.children) child.parentElement = this;
  }

  /** Its words as the page's script reads them. */
  get innerText(): string {
    return this.words();
  }

  /** Its words as drawn: each child on a line of its own. */
  words(): string {
    return this.children.map((child) => (child instanceof Words ? child.textContent : child.words())).join("\n");
  }

  getBoundingClientRect(): { width: number; height: number } {
    return this.drawn ? BOX : NO_BOX;
  }

  scrollIntoView(options: unknown): void {
    this.scrolls += 1;
    this.scrolledWith = options;
  }
}

function el(tag: string, ...children: (Element | string)[]): Element {
  return new Element(tag, children);
}

/** Its runs of text, in the page's order. */
function wordsOf(node: Element): Words[] {
  return node.children.flatMap((child) => (child instanceof Words ? [child] : wordsOf(child)));
}

/** Its elements, itself first. */
function elementsOf(node: Element): Element[] {
  return [node, ...node.children.flatMap((child) => (child instanceof Element ? elementsOf(child) : []))];
}

/** A page whose body holds `children`, as the page's script sees it. */
function pageOf(...children: Element[]): { body: Element; context: object } {
  const body = new Element("body", children);
  const document = {
    body,
    createTreeWalker: (root: Element) => {
      const runs = wordsOf(root);
      return { nextNode: () => runs.shift() ?? null };
    },
  };
  const getComputedStyle = (element: Element) => ({ visibility: "visible", display: element.drawn ? "block" : "none" });
  return { body, context: { document, NodeFilter: { SHOW_TEXT }, getComputedStyle } };
}

/** Shows `text` on the page: whether it was found, and the tags of the elements scrolled to. */
function show(page: ReturnType<typeof pageOf>, text: string, loose: boolean): { found: unknown; scrolled: string[] } {
  const found = runInNewContext(revealScript(text, loose), page.context);
  const scrolled = elementsOf(page.body).filter((element) => element.scrolls > 0);
  return { found, scrolled: scrolled.map((element) => element.tag) };
}

/** A lease page: a label and its value apart, and longer words that hold the value too. */
function lease(): ReturnType<typeof pageOf> {
  return pageOf(
    el(
      "main",
      el("p", "Save $350 a year when you pay the whole lease ahead"),
      el("dl", el("dt", "Monthly price"), el("dd", "$350")),
      el("p", "Deposit: $1,350"),
    ),
  );
}

describe("showing a text on the page", () => {
  it("finds a label and its value apart, punctuation and case aside, only when loose", () => {
    expect(show(lease(), "Monthly price: $350", false)).toEqual({ found: false, scrolled: [] });
    expect(show(lease(), "monthly PRICE: $350", true)).toEqual({ found: true, scrolled: ["dl"] });
  });

  it("finds the words as written first, as before", () => {
    expect(show(lease(), "Deposit: $1,350", true)).toEqual({ found: true, scrolled: ["p"] });
    expect(show(lease(), "Deposit: $1,350", false)).toEqual({ found: true, scrolled: ["p"] });
  });

  it("finds an amount alone, in the drawn element with the fewest characters that holds it", () => {
    const table = el(
      "table",
      el("thead", el("tr", el("th", "Plan"), el("th", "Price"))),
      el("tbody", el("tr", el("td", "Basic"), el("td", el("span", "$350")))),
    );
    const priced = pageOf(el("main", el("p", "Save $350 a year when you pay the whole lease ahead"), table));
    expect(show(priced, "Basic plan price: $350", true)).toEqual({ found: true, scrolled: ["span"] });
    const rated = pageOf(
      el("main", el("p", "Rated 14.5 by critics"), el("p", "4.55 average"), el("div", el("span", "Guests"), "4.5")),
    );
    expect(show(rated, "Rating: 4.5 stars", true)).toEqual({ found: true, scrolled: ["div"] });
    const plans = pageOf(el("main", el("p", "Pro 120/mo"), el("p", "Lite $20/mo")));
    expect(show(plans, "Lite plan at 20/mo, billed monthly", true)).toEqual({ found: true, scrolled: ["p"] });
    const scrolled = elementsOf(plans.body).find((element) => element.scrolls > 0);
    expect(scrolled?.words()).toBe("Lite $20/mo");
  });

  it("scrolls to no element over the length limit, none not drawn, and no lone digit", () => {
    const long = `Terms. ${"Every lease runs a full year and renews by itself. ".repeat(10)}Rent is $350.`;
    const page = pageOf(el("main", el("p", long), new Element("div", ["$350"], false), el("p", "2 beds")));
    expect(show(page, "Rent: $350", true)).toEqual({ found: false, scrolled: [] });
    expect(show(page, "Bedrooms: 2", true)).toEqual({ found: false, scrolled: [] });
  });

  it("finds a value alone only with its currency, percent sign or decimal, never a bare number", () => {
    const hotel = () =>
      pageOf(
        el("main", el("tr", el("td", "19"), el("td", "20"), el("td", "21"))),
        el("p", "Discount: 20 % off all rooms"),
        el("p", "Guest rating 4/5"),
        el("p", "Room 350"),
        el("p", "Fee: 350 USD"),
        el("p", "Total US$ 350"),
        el("p", "Check-in December 20, 2026"),
        el("div", el("span", "Check-in"), el("span", "Friday, November 21")),
        el("footer", "© 2026"),
      );
    for (const text of ["20%", "4.5", "$350", "Dec 20, 2026", "Gate 21", "Check-in: Fri, Nov 21"]) {
      expect(show(hotel(), text, true)).toEqual({ found: false, scrolled: [] });
    }
  });

  it("keeps an amount's currency, decimals and percent sign when it folds a label and its value", () => {
    const rated = pageOf(
      el("dl", el("dt", "Rating"), el("dd", "4/5")),
      el("dl", el("dt", "Price"), el("dd", "350 USD")),
      el("p", "Total $350.75"),
    );
    expect(show(rated, "Rating: 4.5", true)).toEqual({ found: false, scrolled: [] });
    expect(show(rated, "Price: $350", true)).toEqual({ found: false, scrolled: [] });
    expect(show(rated, "Total: $350", true)).toEqual({ found: false, scrolled: [] });
    const listed = pageOf(el("dl", el("dt", "Rating"), el("dd", "4.5")), el("dl", el("dt", "Price"), el("dd", "$350")));
    expect(show(listed, "Rating: 4.5", false)).toEqual({ found: false, scrolled: [] });
    expect(show(listed, "Rating: 4.5", true)).toEqual({ found: true, scrolled: ["dl"] });
  });

  it("scrolls at once when asked, found as written or loosely, and as the page's style says when not", () => {
    const scrolledWith = (text: string, loose: boolean, instant?: boolean) => {
      const page = lease();
      runInNewContext(revealScript(text, loose, instant), page.context);
      return elementsOf(page.body).find((element) => element.scrolls > 0)?.scrolledWith;
    };
    const at = { block: "center", inline: "nearest", behavior: "instant" };
    const asStyled = { block: "center", inline: "nearest" };
    expect(scrolledWith("Deposit: $1,350", false, true)).toEqual(at);
    expect(scrolledWith("Monthly price: $350", true, true)).toEqual(at);
    expect(scrolledWith("Deposit: $1,350", false)).toEqual(asStyled);
    expect(scrolledWith("Monthly price: $350", true)).toEqual(asStyled);
  });

  it("is loose in a browser that says so (revealLoose), and scrolls at once when asked", async () => {
    const shown = async (options: BrowserOptions, instant?: boolean) => {
      const page = lease();
      const settles: number[] = [];
      const tab = {
        targetId: "T",
        gone: false,
        evaluate: async (expression: string) => runInNewContext(expression, page.context),
        settle: async (maxMs: number) => settles.push(maxMs),
      };
      const made = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
      const browser = new made({} as Connection, tab as unknown as Tab, options);
      const found = await browser.reveal("Monthly price: $350", instant);
      const scrolled = elementsOf(page.body).find((element) => element.scrolls > 0);
      return { found, settles: settles.length, behavior: (scrolled?.scrolledWith as { behavior?: string })?.behavior };
    };
    expect(await shown({})).toEqual({ found: false, settles: 0, behavior: undefined });
    expect(await shown({ revealLoose: true })).toEqual({ found: true, settles: 1, behavior: undefined });
    expect(await shown({ revealLoose: true }, true)).toEqual({ found: true, settles: 1, behavior: "instant" });
  });
});
