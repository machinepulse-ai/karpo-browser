import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "../../src/index.ts";
import { HAS_CHROME, scripted, site } from "./support.ts";

/**
 * Sliders as sites build them (a survey of 26 pages, 2026-11-20):
 * - A departure-time filter: two native ranges over one track, counting half hours from 10:30 AM (0 to 32), each
 *   showing its time in aria-valuetext; the page refuses a value that would cross the other thumb.
 * - A price as a native range in its own numbers, and as a slider the page draws that answers keys only after a
 *   while.
 * - A plan picker: a drawn slider counting plans (0 to 8), showing "8,000 subscribers".
 * - Monthly page views: a native range counting plans, its value written only beside it ("500k").
 * - A drawn slider that answers no key.
 */
const SLIDERS = `<title>Filters</title><h1>Filters</h1><style>[role=slider] { display: block; width: 200px; height: 20px; background: silver }</style>
<div><input type=range id=early min=0 max=32 step=1 value=0 aria-label="Earliest departure time">
<input type=range id=late min=0 max=32 step=1 value=32 aria-label="Latest departure time"></div>
<label>Maximum price <input type=range id=price min=0 max=200 step=5 value=50></label>
<div id=drawn role=slider tabindex=0 aria-label="Budget" aria-valuemin=0 aria-valuemax=400 aria-valuenow=40></div>
<div id=plan role=slider tabindex=0 aria-label="Subscribers" aria-valuemin=0 aria-valuemax=8 aria-valuenow=1></div>
<input type=range id=views min=0 max=8 step=1 value=0 aria-label="Monthly page views"><span id=viewsOut>10k</span>
<div id=stuck role=slider tabindex=0 aria-label="Brightness" aria-valuemin=0 aria-valuemax=10 aria-valuenow=3></div>
<div id=term role=slider tabindex=0 aria-label="Loan term" aria-valuemin=0 aria-valuemax=6 aria-valuenow=2></div>
<div id=events role=slider tabindex=0 aria-label="Monthly events" aria-valuemin=0 aria-valuemax=5000 aria-valuenow=0></div>
<input type=range id=tier min=0 max=8 step=1 value=1 aria-label="Contacts" aria-valuetext="1000">
<div id=loose role=slider aria-label="Zoom" aria-valuemin=0 aria-valuemax=10 aria-valuenow=3></div>
<script>
  const time = (slot) => { const m = 630 + slot * 30, day = m >= 1440 ? "Sat" : "Fri", h = Math.floor(m / 60) % 24;
    return day + ", " + String(h % 12 || 12).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM"); };
  const held = { early: 0, late: 32 };
  for (const id of ["early", "late"]) {
    const input = document.getElementById(id);
    const show = () => { input.value = held[id]; input.setAttribute("aria-valuetext", time(held[id])); };
    input.addEventListener("input", () => {
      const asked = Number(input.value);
      if (id === "early" ? asked < held.late : asked > held.early) held[id] = asked;
      show();
    });
    show();
  }
  const keyed = (id, step, show, delay) => {
    const slider = document.getElementById(id);
    slider.addEventListener("keydown", (event) => {
      const by = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
      if (by === 0) return;
      const next = Math.min(Math.max(Number(slider.getAttribute("aria-valuenow")) + by, Number(slider.getAttribute("aria-valuemin"))), Number(slider.getAttribute("aria-valuemax")));
      setTimeout(() => { slider.setAttribute("aria-valuenow", next); show(slider, next); }, delay);
    });
    show(slider, Number(slider.getAttribute("aria-valuenow")));
  };
  keyed("drawn", 5, () => {}, 120);
  const plans = ["300", "1,000", "3,000", "5,000", "8,000", "10,000", "15,000", "20,000", "25,000"];
  keyed("plan", 1, (slider, at) => slider.setAttribute("aria-valuetext", plans[at] + " subscribers"), 0);
  const terms = ["6 months", "12 months", "18 months", "24 months", "36 months", "48 months", "60 months"];
  keyed("term", 1, (slider, at) => slider.setAttribute("aria-valuetext", terms[at]), 120);
  const sizes = [0, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  document.getElementById("events").addEventListener("keydown", (event) => {
    const slider = event.currentTarget, by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const at = Math.min(Math.max(sizes.indexOf(Number(slider.getAttribute("aria-valuenow"))) + by, 0), sizes.length - 1);
    slider.setAttribute("aria-valuenow", sizes[at]);
  });
  const tiers = [300, 1000, 3000, 5000, 8000, 10000, 15000, 20000, 25000];
  document.getElementById("tier").addEventListener("input", (event) => event.target.setAttribute("aria-valuetext", tiers[event.target.value]));
  const viewsShown = ["10k", "100k", "200k", "500k", "1M", "2M", "5M", "10M", "10M+"];
  document.getElementById("views").addEventListener("input", (event) => { viewsOut.textContent = viewsShown[event.target.value]; });
</script>`;

describe.skipIf(!HAS_CHROME)("FILL on a slider", () => {
  let local: Awaited<ReturnType<typeof site>>;
  beforeAll(async () => {
    local = await site({ "/": SLIDERS });
  });
  afterAll(() => local.server.close());

  /** One FILL of `value` on the slider a line names, then DONE: the latest actions, and the page asked `reads`. */
  async function fill(
    line: string,
    value: string,
    reads: string,
    first?: string,
  ): Promise<{ recent: string; read: unknown }> {
    let filled = false;
    const decider = scripted({
      step: (page) => {
        if (filled) return "DONE";
        filled = true;
        return `FILL ${page.numberOf(line)}`;
      },
      value: () => "1",
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/`);
      if (first) await browser.tab.evaluate(first);
      const result = await browser.run({ goal: "Set the filter", values: { setting: value } });
      return { recent: result.recent.join("\n"), read: await browser.tab.evaluate(reads) };
    } finally {
      await browser.close();
    }
  }
  const NOT_KEPT = "the page did not keep the value";

  it("sets a range that counts in steps of its own to the time it shows, not to the number in the text", async () => {
    const early = await fill(
      "slider Earliest departure",
      "2:00 PM",
      "[early.value, early.getAttribute('aria-valuetext')]",
    );
    expect(early.read).toEqual(["7", "Fri, 02:00 PM"]);
    expect(early.recent).not.toContain(NOT_KEPT);
  });

  it("finds the time below where the thumb is, on a thumb the page keeps from going to its low end", async () => {
    const late = await fill("slider Latest departure", "6:00 PM", "[late.value, late.getAttribute('aria-valuetext')]");
    expect(late.read).toEqual(["15", "Fri, 06:00 PM"]);
  });

  it("leaves the range where it was, and says so, when it shows the time asked nowhere", async () => {
    const early = await fill("slider Earliest departure", "9:15 AM", "[early.value, late.value]");
    expect(early.read).toEqual(["0", "32"]);
    expect(early.recent).toContain(`${NOT_KEPT}; the box holds "Fri, 10:30 AM"`);
  });

  it("sets a range in its own numbers through the element, and refuses a number off its steps", async () => {
    expect((await fill("slider Maximum price", "$20", "price.value")).read).toBe("20");
    const off = await fill("slider Maximum price", "$22", "price.value");
    expect(off.read).toBe("50");
    expect(off.recent).toContain(`${NOT_KEPT}; the box holds "50"`);
  });

  it("moves a slider the page draws by keys, waiting for one that answers late", async () => {
    expect((await fill("slider Budget", "$120", "drawn.getAttribute('aria-valuenow')")).read).toBe("120");
    const off = await fill("slider Budget", "$122", "drawn.getAttribute('aria-valuenow')");
    expect(off.read).toBe("40");
    expect(off.recent).toContain(`${NOT_KEPT}; the box holds "40"`);
  });

  it("steps a drawn slider to the words it shows", async () => {
    const plan = await fill(
      "slider Subscribers",
      "8000",
      "[plan.getAttribute('aria-valuenow'), plan.getAttribute('aria-valuetext')]",
    );
    expect(plan.read).toEqual(["4", "8,000 subscribers"]);
  });

  it("does not set a range whose value is written only beside it", async () => {
    const views = await fill("slider Monthly page views", "500k", "[views.value, viewsOut.textContent]");
    expect(views.read).toEqual(["0", "10k"]);
    expect(views.recent).toContain(NOT_KEPT);
  });

  it("puts a drawn slider that shows words back exactly, though the page takes quick presses for one", async () => {
    const term = await fill(
      "slider Loan term",
      "90 months",
      "[term.getAttribute('aria-valuenow'), term.getAttribute('aria-valuetext')]",
    );
    expect(term.read).toEqual(["2", "18 months"]);
    expect(term.recent).toContain(`${NOT_KEPT}; the box holds "18 months"`);
    expect((await fill("slider Loan term", "48 months", "term.getAttribute('aria-valuenow')")).read).toBe("5");
  });

  it("reaches a number on steps of uneven size, and leaves one it passes without holding", async () => {
    expect((await fill("slider Monthly events", "500", "events.getAttribute('aria-valuenow')")).read).toBe("500");
    const off = await fill("slider Monthly events", "300", "events.getAttribute('aria-valuenow')");
    expect(off.read).toBe("0");
    expect(off.recent).toContain(NOT_KEPT);
  });

  it("moves by keys a range that shows another number than its value", async () => {
    const tier = await fill("slider Contacts", "3000", "[tier.value, tier.getAttribute('aria-valuetext')]");
    expect(tier.read).toEqual(["2", "3000"]);
  });

  it("sends no key when the slider cannot take the focus", async () => {
    const loose = await fill("slider Zoom", "7", "[loose.getAttribute('aria-valuenow'), price.value]", "price.focus()");
    expect(loose.read).toEqual(["3", "50"]);
    expect(loose.recent).toContain(NOT_KEPT);
  });

  it("says so when keys do not move a drawn slider", async () => {
    const stuck = await fill("slider Brightness", "7", "stuck.getAttribute('aria-valuenow')");
    expect(stuck.read).toBe("3");
    expect(stuck.recent).toContain(`${NOT_KEPT}; the box holds "3"`);
  });
});
