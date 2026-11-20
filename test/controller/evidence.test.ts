import { describe, expect, it } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import type { Tab } from "../../src/browser/tab.ts";
import type { BrowserOptions } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";
import { evidenceText } from "./evidence.ts";

const SAID = '"$98.29" is in view';
const URL_ = "https://shop.test/item/1";

/** A product page as read after a show scrolled to its price. */
const PRODUCT = {
  url: URL_,
  title: "Brother HL-L2350DW",
  lines: [
    "viewport (scrolled 600/2400px):",
    "  main",
    "    heading Brother HL-L2350DW Monochrome Laser Printer",
    "    text Sold by Office Depot",
    "    text $98.29",
    "    13 button Add to cart",
    "above:",
    "  2 link Home href=/",
    "below:",
    "  40 link Reviews href=/reviews",
  ],
};

describe("a show's evidence", () => {
  it("gives the line that holds the text and its neighbours in its part, with the page's title and address", () => {
    expect(evidenceText(SAID, PRODUCT, "$98.29")).toBe(
      [
        '"$98.29" is in view on Brother HL-L2350DW:',
        "main",
        "heading Brother HL-L2350DW Monochrome Laser Printer",
        "text Sold by Office Depot",
        "text $98.29",
        "13 button Add to cart",
        `(${URL_})`,
      ].join("\n"),
    );
  });

  it("keeps the lines to 400 characters, one above and one below in turn", () => {
    const lines = [
      "page (scrolled 0/0px):",
      ...Array.from({ length: 20 }, (_, i) => `  text line ${i} ${"x".repeat(90)}`),
    ];
    lines[10] = "  text Total $98.29";
    const said = evidenceText(SAID, { url: URL_, title: "Cart", lines }, "$98.29").split("\n");
    const kept = said.slice(1, -1);
    expect(kept.join("\n").length).toBeLessThanOrEqual(400);
    expect(kept.map((line) => line.slice(0, 12))).toEqual([
      "text line 7 ",
      "text line 8 ",
      "text Total $",
      "text line 10",
    ]);
  });

  it("cuts a line that holds the text but is longer than that, and gives it alone", () => {
    const lines = ["page (scrolled 0/0px):", "  text before", `  text $98.29 ${"y".repeat(600)}`, "  text after"];
    const kept = evidenceText(SAID, { url: URL_, title: "T", lines }, "$98.29").split("\n").slice(1, -1);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.length).toBe(400);
    expect(kept[0]!.endsWith("…")).toBe(true);
  });

  it("keeps the words around the text in a line longer than that, wherever in the line the text is", () => {
    const said = (line: string, wanted: string) => {
      const lines = ["page (scrolled 0/0px):", "  text before", `  text ${line}`];
      return evidenceText(SAID, { url: URL_, title: "T", lines }, wanted).split("\n").slice(1, -1);
    };
    // Commas and runs of spaces before the text, as a show's search drops them, do not move the excerpt off it.
    const report = `In its report for 2024,  the foundation said ${"its programmes grew, and,  ".repeat(30)}`;
    const middle = said(`${report}a grant of $4.5 million came in, ${"y".repeat(400)}`, "Grant: $4.5M");
    expect(middle).toHaveLength(1);
    expect(middle[0]).toHaveLength(400);
    expect(middle[0]!.startsWith("…") && middle[0]!.endsWith("…")).toBe(true);
    expect(middle[0]!.indexOf("$4.5 million came in")).toBe(200);
    const end = said(`${"z".repeat(900)} in all, Total $4.5 million`, "total: $4.5 million");
    expect(end).toHaveLength(1);
    expect(end[0]).toHaveLength(400);
    expect(end[0]!.startsWith("…")).toBe(true);
    expect(end[0]!.endsWith("in all, Total $4.5 million")).toBe(true);
  });

  it("finds the line as a show does: folded, then by an amount that stands alone", () => {
    const lines = [
      "viewport (scrolled 0/900px):",
      "  text Monthly price $350/mo",
      "  heading Rating",
      "  text Size 14.6 in",
      "  text 4.6 out of 5",
    ];
    const page = { url: URL_, title: "Flat", lines };
    expect(evidenceText("s", page, "Monthly price: $350").split("\n")).toContain("text Monthly price $350/mo");
    const rated = evidenceText("s", { ...page, lines: [lines[0]!, ...lines.slice(2)] }, "Rating: 4.6 stars");
    expect(rated.split("\n").slice(1, -1)).toEqual(["heading Rating", "text Size 14.6 in", "text 4.6 out of 5"]);
  });

  it("names the page alone when no line holds the text, and leaves out a title the page has not", () => {
    expect(evidenceText(SAID, PRODUCT, "$1.00")).toBe(`${SAID} on Brother HL-L2350DW (${URL_})`);
    expect(evidenceText(SAID, { ...PRODUCT, title: "" }, "$98.29").split("\n")[0]).toBe(`${SAID}:`);
  });
});

describe("a screenshot a person can read", () => {
  /** The widths a browser asked its tab's screenshot to be, with the screenshot setting given. */
  const asked = async (options: BrowserOptions) => {
    const widths: (number | undefined)[] = [];
    const tab = {
      targetId: "T",
      gone: false,
      viewportJpeg: async (_quality: number, width?: number) => {
        widths.push(width);
        return { jpeg: new Uint8Array([0xff, 0xd8]), width: 1288, height: 711 };
      },
    };
    const made = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
    const shot = await new made({} as Connection, tab as unknown as Tab, options).readableScreenshot();
    return { widths, shot: shot?.length };
  };

  it("is taken at the browser's own resolution up to 1600 pixels wide, whole where scaling crops, none when off", async () => {
    expect(await asked({ screenshot: "scaled" })).toEqual({ widths: [1_600], shot: 2 });
    expect(await asked({ screenshot: "full" })).toEqual({ widths: [undefined], shot: 2 });
    expect(await asked({ screenshot: "none" })).toEqual({ widths: [], shot: undefined });
  });
});
