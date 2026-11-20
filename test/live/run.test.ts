import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChrome } from "../../src/browser/chrome.ts";
import { Browser } from "../../src/index.ts";
import { HAS_CHROME, scripted, site } from "./support.ts";

const FORM = `<title>Book a table</title><h1>Book a table</h1>
<form onsubmit="event.preventDefault(); out.textContent = 'Booked for ' + who.value + ', ' + size.value + ' at ' + time.value">
<label>Name <input id=who></label>
<label>Party size <select id=size><option>1<option>2<option>3</select></label>
<label>Time <input id=time type=time></label>
<label>Card number <input id=card></label>
<button>Book</button></form><p id=out></p>`;
const OPENER = `<title>Shop</title><button onclick="window.open('/sign-in')">Sign in</button><p id=out>Signed out</p>`;
const SIGN_IN = `<title>Sign in</title><button onclick="opener.document.getElementById('out').textContent = 'Signed in'; window.close()">Finish</button>`;

/** A calendar's event link that the page's own handling of a click keeps from going anywhere. */
const CALENDAR = `<title>Calendar</title><h1>Events</h1><a id=walk href="/event?id=7">Discovery Walk</a>
<script>walk.addEventListener("click", (click) => click.preventDefault());</script>`;
const EVENT = `<title>Discovery Walk</title><h1>Discovery Walk</h1><p>Meet in front of the museum.</p>`;

const PHRASE = `<title>Phrase</title><div role="textbox" contenteditable="true" aria-label="Pass phrase" type="password"
  oninput="echo.textContent = 'You entered ' + this.textContent"></div><p id=echo></p>`;

/** A port nothing listens on, for now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A server of one page on a port. */
async function serving(port: number, page: string): Promise<Server> {
  const server = createServer((_, response) =>
    response.setHeader("content-type", "text/html").end(`<!doctype html>${page}`),
  );
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

describe.skipIf(!HAS_CHROME)("a run on a live page", () => {
  let local: Awaited<ReturnType<typeof site>>;
  beforeAll(async () => {
    local = await site({
      "/": FORM,
      "/shop": OPENER,
      "/sign-in": SIGN_IN,
      "/phrase": PHRASE,
      "/calendar": CALENDAR,
      "/event?id=7": EVENT,
    });
  });
  afterAll(() => local.server.close());

  it("fills, selects, sets a native time, clicks and ends on DONE", async () => {
    const decider = scripted({
      step: (page) => {
        if (page.has("Booked for")) return "DONE";
        if (page.has("textbox Name [value=]")) return `FILL ${page.numberOf("textbox Name")}`;
        if (page.has("select Party size [value=1]")) return `SELECT ${page.numberOf("select Party size")}`;
        if (page.has("Time [value=]")) return `FILL ${page.numberOf("Time [value=]")}`;
        return `CLICK ${page.numberOf("button Book")}`;
      },
      value: (instructions) => (instructions.includes("Name") ? "1" : "2"),
      option: (criteria) => Object.entries(criteria).find(([, text]) => text === "2")?.[0] ?? "NONE",
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/`);
      const result = await browser.run({
        goal: "Book for Ann, 2 people, 7:30 pm",
        values: { name: "Ann", time: "7:30 pm" },
      });
      expect(result.status).toBe("done");
      expect(result.actions).toEqual([
        "FILL textbox Name 1",
        "SELECT select Party size 2",
        "FILL InputTime Time 2",
        "CLICK button Book",
      ]);
      expect(await browser.tab.evaluate("out.textContent")).toBe("Booked for Ann, 2 at 19:30");
      // The step's requests carry the screenshot; a follow-up carries none.
      const followUps = decider.requests.filter(({ request }) => !("step" in request.questions));
      expect(followUps.length).toBe(3);
      expect(followUps.every(({ context }) => context.image === undefined)).toBe(true);
      expect(decider.requests.filter(({ context }) => context.image !== undefined).length).toBe(5);
    } finally {
      await browser.close();
    }
  });

  it("keeps a typed secret out of every request, in this run and the next", async () => {
    const decider = scripted({
      step: (page) => (page.has("Card number [value=]") ? `FILL ${page.numberOf("Card number")}` : "DONE"),
      value: () => "1",
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/`);
      const input = { goal: "Enter the card", secrets: { "card number": "4111111111111111" } };
      expect((await browser.run(input)).status).toBe("done");
      expect(await browser.tab.evaluate("card.value")).toBe("4111111111111111");
      const second = await browser.run(input);
      expect(second.page.join("\n")).toContain("Card number [value=•••• (16 characters)]");
      expect(JSON.stringify([decider.requests, second])).not.toContain("4111");
      // Once a secret was typed no screenshot is taken, in the next run either.
      expect(decider.requests.at(-1)?.context.image).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it("writes as dots a secret typed into an editable region, and what the page shows of it elsewhere", async () => {
    const decider = scripted({
      step: (page) =>
        page.has("textbox Pass phrase [value=•••• (0 characters)]")
          ? `FILL ${page.numberOf("textbox Pass phrase")}`
          : "DONE",
      value: () => "1",
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/phrase`);
      // A made-up phrase: nothing a scanner for real keys would take for one.
      const phrase = "open sesame 987654";
      const result = await browser.run({ goal: "Enter the phrase", secrets: { "pass phrase": phrase } });
      expect(result.status).toBe("done");
      expect(await browser.tab.evaluate("document.querySelector('[role=textbox]').textContent")).toBe(phrase);
      expect(await browser.tab.evaluate("echo.textContent")).toBe(`You entered ${phrase}`);
      expect(JSON.stringify([decider.requests, result, await browser.read()])).not.toContain("sesame");
      expect(result.page.join("\n")).toContain(`You entered ${"•".repeat(phrase.length)}`);
    } finally {
      await browser.close();
    }
  });

  it("carries out no step once it was stopped while the model decided", async () => {
    const stop = new AbortController();
    const decider = scripted({
      step: (page) => {
        stop.abort();
        return `CLICK ${page.numberOf("button Book")}`;
      },
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/`);
      const result = await browser.run({ goal: "Book" }, { signal: stop.signal });
      expect(result.status).toBe("interrupted");
      expect(await browser.tab.evaluate("out.textContent")).toBe("");
    } finally {
      await browser.close();
    }
  });

  it("goes on in the page that opened a window once the window closes itself", async () => {
    const decider = scripted({
      step: (page) => {
        if (page.has("Signed in")) return "DONE";
        return page.has("button Finish")
          ? `CLICK ${page.numberOf("button Finish")}`
          : `CLICK ${page.numberOf("button Sign in")}`;
      },
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/shop`);
      const result = await browser.run({ goal: "Sign in" });
      expect([result.status, result.title]).toEqual(["done", "Shop"]);
      expect(result.actions).toEqual(["CLICK button Sign in", "CLICK button Finish"]);
    } finally {
      await browser.close();
    }
  });

  it("opens the address of a link a click left where it was, and reads as a click that led there", async () => {
    const decider = scripted({
      step: (page) => (page.has("Meet in front") ? "DONE" : `CLICK ${page.numberOf("link Discovery Walk")}`),
    });
    const browser = await Browser.launch({ headless: true, decider });
    try {
      await browser.open(`${local.url}/calendar`);
      const result = await browser.run({ goal: "Find where the Discovery Walk meets" });
      expect([result.status, result.actions]).toEqual(["done", ["CLICK link Discovery Walk"]]);
      expect(result.recent).toEqual([
        `CLICK link Discovery Walk\n  page → ${local.url.slice("http://".length)}/event?id=7`,
      ]);
    } finally {
      await browser.close();
    }
  });

  it("opens again a page the browser could not reach for a network error, and works it as one reached at once", async () => {
    const decider = scripted({ step: () => "DONE" });
    const browser = await Browser.launch({ headless: true, decider, screenshot: "none" });
    const port = await freePort();
    const address = `http://127.0.0.1:${port}/`;
    let server: Server | undefined;
    try {
      // The first try finds nothing on the port (a connection refused); the page's server starts before the next.
      const starting = new Promise((resolve) => setTimeout(resolve, 500)).then(async () => {
        server = await serving(port, EVENT);
      });
      await Promise.all([browser.open(address), starting]);
      const goal = { goal: "Find where the Discovery Walk meets" };
      expect((await browser.run(goal)).status).toBe("done");
      await browser.open(address);
      expect((await browser.run(goal)).status).toBe("done");
      const [reopened, reached] = decider.requests.map(({ request }) => JSON.stringify(request));
      expect(reopened).toContain("Meet in front of the museum.");
      expect(reopened).toBe(reached);
    } finally {
      server?.close();
      await browser.close();
    }
  });

  it("says so when Chrome cannot be started, and can be let go twice", async () => {
    await expect(launchChrome({ executablePath: "/no/such/chrome" })).rejects.toThrow(/did not start/);
    const chrome = await launchChrome({ headless: true });
    await chrome.close();
    await chrome.close();
  });
});
