import { describe, expect, it } from "vitest";
import type { PageCapture } from "../../src/contracts/capture.ts";
import { SNAPSHOT_STYLES } from "../../src/contracts/capture.ts";
import { Texts } from "../../src/contracts/texts.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import { capturedDom, colorAlpha } from "../../src/reading/dom.ts";
import { BoxUnion } from "../../src/reading/geometry.ts";
import { shortUrl } from "../../src/reading/state.ts";
import type { SelectOption } from "../../src/reading/tree.ts";
import { optionsWindow, readPage, sameName } from "../../src/reading/tree.ts";
import { lineText, wholeSelection, writePage } from "../../src/reading/write.ts";
import { read } from "../../src/run/page.ts";
import { button, captureOf, deals, heading, main } from "./fake.ts";

/** A one-node capture whose node's styles are `values`, listed by `styles` (none: the reading's own list). */
function oneNode(styles: readonly string[], values: readonly string[]): PageCapture {
  const strings = ["HTML", ...values];
  return {
    viewport: { w: 100, h: 100 },
    scroll: { top: 0, maxTop: 0 },
    frames: [
      {
        session: "S",
        top: true,
        offset: { x: 0, y: 0 },
        snapshot: {
          documents: [
            {
              nodes: { parentIndex: [-1], nodeType: [1], nodeName: [0], backendNodeId: [7] },
              layout: { nodeIndex: [0], bounds: [[0, 0, 10, 10]], styles: [values.map((_, at) => at + 1)] },
            },
          ],
          strings,
        },
        accessibility: [],
      },
    ],
    unreadFrames: 0,
    ...(styles.length > 0 ? { styles: [...styles] } : {}),
  };
}

function options(count: number, selected: number | undefined): SelectOption[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    text: String(index),
    value: String(index),
    selected: index === selected,
    disabled: false,
  }));
}

describe("the page's facts", () => {
  it("a colour shows by its alpha whatever the colour", () => {
    expect(colorAlpha("rgba(0, 0, 0, 0)")).toBe(0);
    expect(colorAlpha("rgba(255, 255, 255, 0)")).toBe(0);
    expect(colorAlpha("rgba(0, 0, 0, 0.5)")).toBe(0.5);
    expect(colorAlpha("rgb(255, 255, 255)")).toBe(1);
    expect(colorAlpha("color(srgb 1 1 1 / 0)")).toBe(0);
    expect(colorAlpha("oklch(0.5 0.1 200 / 40%)")).toBe(0.4);
    expect(colorAlpha("")).toBe(0);
  });

  it("styles are read by name whatever list the capture took", () => {
    const values = [
      "block",
      "visible",
      "pointer",
      "hidden",
      "auto",
      "fixed",
      "rgb(1, 2, 3)",
      "0.5",
      "none",
      "inset(1px)",
    ];
    const plain = capturedDom(oneNode([], values)).nodes[0]!.style!;
    const reordered = capturedDom(oneNode(SNAPSHOT_STYLES.toReversed(), values.toReversed())).nodes[0]!.style!;
    expect(reordered).toEqual(plain);
    expect([plain.display, plain.position, plain.clipPath]).toEqual(["block", "fixed", "inset(1px)"]);
    // A style the capture did not take reads empty.
    const partial = capturedDom(oneNode(["display"], ["inline"])).nodes[0]!.style!;
    expect([partial.display, partial.position]).toEqual(["inline", ""]);
  });

  it("a box is held only by boxes that cover it whole together", () => {
    const union = new BoxUnion({ x: 0, y: 0, w: 200, h: 200 });
    expect(union.holds({ x: 10, y: 10, w: 5, h: 5 })).toBe(false);
    union.add({ x: 0, y: 0, w: 50, h: 100 });
    union.add({ x: 50, y: 0, w: 50, h: 100 });
    expect(union.holds({ x: 40, y: 10, w: 20, h: 20 })).toBe(true);
    expect(union.holds({ x: 90, y: 10, w: 20, h: 20 })).toBe(false);
    expect(union.holds({ x: 0, y: 0, w: 100, h: 100 })).toBe(true);
  });
});

/** A page at `base` with one link written `href`, as a capture; the link's line as the reading writes it. */
function linkLine(base: string, href: string): string {
  const strings = ["HTML", "A", "href", href, base, "block", "visible"];
  const capture: PageCapture = {
    viewport: { w: 100, h: 100 },
    scroll: { top: 0, maxTop: 0 },
    frames: [
      {
        session: "S",
        top: true,
        offset: { x: 0, y: 0 },
        snapshot: {
          documents: [
            {
              documentURL: 4,
              nodes: {
                parentIndex: [-1, 0],
                nodeType: [1, 1],
                nodeName: [0, 1],
                backendNodeId: [1, 2],
                attributes: [[], [2, 3]],
              },
              layout: {
                nodeIndex: [0, 1],
                bounds: [
                  [0, 0, 100, 100],
                  [0, 0, 50, 10],
                ],
                styles: [
                  [5, 6],
                  [5, 6],
                ],
              },
            },
          ],
          strings,
        },
        accessibility: [[{ nodeId: "2", backendDOMNodeId: 2, role: { value: "link" }, name: { value: "Go" } }]],
      },
    ],
    unreadFrames: 0,
    styles: ["display", "visibility"],
  };
  const tree = readPage(capture, { reading: DEFAULT_PROFILE.reading, secrets: new Set() });
  return (
    writePage(tree, wholeSelection(), new Map(), DEFAULT_PROFILE.reading, new Texts(DEFAULT_PROFILE.texts)).lines[1] ??
    ""
  );
}

describe("a link's address", () => {
  const base = "https://www.site.test/list?page=2";

  it("is its path on this site, its host and path on another, and whole when it is no web address", () => {
    expect(linkLine(base, "/items/3?ref=a#top")).toBe("  2 link Go href=/items/3");
    expect(linkLine(base, "https://other.test/x")).toBe("  2 link Go href=other.test/x");
    expect(linkLine(base, "mailto:a@b.c")).toBe("  2 link Go href=mailto:a@b.c");
    expect(linkLine(base, "#top")).toBe("  2 link Go");
  });

  it("is resolved as the reader the model was trained with resolves it, where a browser differs", () => {
    expect(linkLine(base, "////other.test/x")).toBe("  2 link Go");
    expect(linkLine(base, "/a^b")).toBe("  2 link Go href=/a^b");
    expect(linkLine(base, "/a%5Eb")).toBe("  2 link Go href=/a%5Eb");
  });
});

describe("the page tree", () => {
  it("names are the same whatever spaces are around or between their words", () => {
    expect(sameName("Personal Information / First name ", "Personal Information / First name")).toBe(true);
    expect(sameName(" Contact Information  E-mail\n", "Contact Information E-mail")).toBe(true);
    expect(sameName("First name", "Firstname")).toBe(false);
  });

  it("a dropdown lists the options around its value", () => {
    expect(optionsWindow(options(48, 38), 30)).toEqual({ start: 18, end: 48 });
    expect(optionsWindow(options(48, 20), 30)).toEqual({ start: 5, end: 35 });
    expect(optionsWindow(options(48, undefined), 30)).toEqual({ start: 0, end: 30 });
    expect(optionsWindow(options(3, 1), 30)).toEqual({ start: 0, end: 3 });
  });

  it("an address is read without its scheme, fragment and trailing slashes", () => {
    expect(shortUrl("https://www.tablecheck.com/en/japan/#top")).toBe("www.tablecheck.com/en/japan");
    expect(shortUrl("about:blank")).toBe("about:blank");
  });
});

describe("a page that changes by itself", () => {
  /** The deals page at a reading, read: its lines as a request writes them whole, and its state. */
  function readDeals(reading: number, sizes: boolean): { lines: string[]; state: string } {
    const { tree, state } = read(captureOf(deals(reading, sizes)), {
      reading: DEFAULT_PROFILE.reading,
      secrets: new Set(),
    });
    const texts = new Texts(DEFAULT_PROFILE.texts);
    return { lines: writePage(tree, wholeSelection(), new Map(), DEFAULT_PROFILE.reading, texts).lines, state };
  }

  it("reads as the base code read it", () => {
    expect([readDeals(0, false), readDeals(1, true)]).toMatchSnapshot();
  });

  const options = { reading: DEFAULT_PROFILE.reading, secrets: new Set<string>() };

  it("marks it: a carousel and a marquee whole, the words of a live region, a status and a timer", () => {
    const { tree } = read(captureOf(deals(0, false)), options);
    const texts = new Texts(DEFAULT_PROFILE.texts);
    const changing = [...tree.changing].sort((a, b) => a - b).map((at) => lineText(tree, at, new Map(), texts, true));
    expect(changing).toEqual([
      "region Featured",
      "group 1 of 3",
      "heading Save 20% on trail shoes",
      "2 link Shop now href=/sale/trail",
      "3 timer Ends in 00:59",
      "4 status Saved 0s ago",
      "5 div",
      "text 3 shoppers viewing",
      "7 marquee Free returns on shoes",
    ]);
  });

  it("marks nothing the page does not say changes by itself", () => {
    const off = { tag: "div", attrs: { "aria-live": "off" }, props: { live: "off" }, children: ["Price $40"] };
    const product = {
      tag: "section",
      attrs: { "aria-roledescription": "product" },
      role: "region",
      name: "Trail runner",
      props: { roledescription: "product" },
      children: [heading("Trail runner"), button("Add to cart")],
    };
    const page = { url: "https://shop.test/item/1", title: "Trail runner", body: [main(off, product)] };
    expect(read(captureOf(page), options).tree.changing.size).toBe(0);
  });

  it("leaves it out of the page's steady state, not of its state", () => {
    const at = (reading: number, sizes: boolean) => read(captureOf(deals(reading, sizes)), options);
    const [hidden, turned, shown] = [at(0, false), at(1, false), at(0, true)];
    expect(turned.state).not.toBe(hidden.state);
    expect([turned.steady, shown.steady === hidden.steady]).toEqual([hidden.steady, false]);
    const plain = read(captureOf({ url: "https://shop.test/", title: "Shop", body: [main(button("Go"))] }), options);
    expect(plain.steady).toBe(plain.state);
  });
});

describe("a frame the page hides", () => {
  /** The first backend node id of the challenge's own document, apart from the checkout's. */
  const CHALLENGE_FIRST_ID = 500;
  /** Where the challenge frame sits in the viewport: in view, so only its `<iframe>`'s visibility hides it. */
  const CHALLENGE_OFFSET = { x: 0, y: 100 };

  /**
   * A checkout as Eventbrite's is (2026-11-20), read: its hCaptcha challenge is an out-of-process frame in an
   * `<iframe>` of the visibility given, which the widget keeps hidden until it asks something.
   */
  function checkout(visibility: string): string {
    const page = captureOf({
      url: "https://tickets.test/checkout",
      title: "Checkout",
      body: [main(heading("Checkout"), button("Register"), { tag: "iframe", attrs: { title: "hCaptcha challenge" } })],
    });
    const challenge = captureOf({
      url: "https://captcha.test/challenge",
      title: "hCaptcha",
      body: [main("Please try again.", button("Verify Answers"))],
      firstId: CHALLENGE_FIRST_ID,
    });
    const top = page.frames[0]!;
    const { strings } = top.snapshot;
    const document = top.snapshot.documents[0] as {
      nodes: { nodeName: number[]; backendNodeId: number[] };
      layout: { nodeIndex: number[]; styles: number[][] };
    };
    const iframe = document.nodes.nodeName.findIndex((name) => strings[name] === "IFRAME");
    const row = document.layout.nodeIndex.indexOf(iframe);
    strings.push(visibility);
    document.layout.styles[row]![SNAPSHOT_STYLES.indexOf("visibility")] = strings.length - 1;
    const frame = {
      ...challenge.frames[0]!,
      session: "S2",
      target: "T2",
      top: false,
      offset: CHALLENGE_OFFSET,
      owner: { session: top.session, backendNodeId: document.nodes.backendNodeId[iframe]! },
    };
    const { tree } = read({ ...page, frames: [top, frame] }, { reading: DEFAULT_PROFILE.reading, secrets: new Set() });
    const texts = new Texts(DEFAULT_PROFILE.texts);
    return writePage(tree, wholeSelection(), new Map(), DEFAULT_PROFILE.reading, texts).lines.join("\n");
  }

  it("reads the frame's document while its <iframe> is visible", () => {
    const lines = checkout("visible");
    expect(lines).toContain("button Register");
    expect(lines).toContain("button Verify Answers");
  });

  it("reads nothing of it while its <iframe> is hidden: no visibility passes into another document", () => {
    for (const visibility of ["hidden", "collapse"]) {
      const lines = checkout(visibility);
      expect(lines).toContain("button Register");
      expect(lines).not.toContain("Verify Answers");
      expect(lines).not.toContain("Please try again");
    }
  });
});
