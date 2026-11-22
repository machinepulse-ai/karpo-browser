import { describe, expect, it } from "vitest";
import type { StepRecord } from "../../src/index.ts";
import type { ToolEvent } from "../../test/controller/controller.ts";
import * as tools from "../../test/controller/tools.ts";
import { browserActionsFor, DONE_TOLD_MOST, scrub, secretsOf, Teller } from "./events.ts";

/** The facade's server name, as the input gives it, and a task's tool-call budget. */
const SERVER = "stagehand";
const BUDGET = 100;
/** A screenshot, and the image the harness is told it as. */
const SHOT = new Uint8Array([0xff, 0xd8, 0xff]);
const IMAGE = { data: Buffer.from(SHOT).toString("base64"), mime_type: "image/jpeg" };
const PAGE_URL = "https://books.toscrape.com/";
const PAGE_STATE = "the shop's front page";
/** The words System 1's question gave the option each step chose. */
const OPTION_WORDS = "the link A Light in the Attic";

/** A step of System 1 that chose `key`, with the page's screenshot when one is given. */
function step(key: string, screenshot?: Uint8Array, note?: string): StepRecord {
  return {
    step: 1,
    url: PAGE_URL,
    state: PAGE_STATE,
    requests: [
      {
        state: { task: { goal: "Open the book" }, values: [], page: { url: PAGE_URL, title: "Books", elements: [] } },
        questions: {
          step: { type: "choice", instructions: "Choose the next step", criteria: { [key]: OPTION_WORDS } },
        },
      },
    ],
    key,
    note,
    ...(screenshot ? { readableScreenshot: screenshot } : {}),
  };
}

/** The tool calls told before the controller starts: the facade's one call. */
const CALLS_BEFORE = 1;
/** The start read told as evidence. */
const START_READS = 1;
/** A budget too small to leave the controller any browser action. */
const SMALL_BUDGET = 5;

/** Words said to the harness, as an event. */
const words = (text: string) => expect.objectContaining({ type: "assistant", text });

describe("what the agent hides", () => {
  it("hides each key it may know of", () => {
    const env = {
      BROWSERBASE_API_KEY: "bb_live_testKeyNotReal_0123456789",
      SYSTEM1_API_KEY: "system1-key-not-real",
      SYSTEM2_API_KEY: "sk-or-v1-not-real-0123",
      OPENAI_API_KEY: "sk-or-v1-judge-not-real",
    };
    const said = Object.values(env).join(" and ");
    expect(scrub(said, secretsOf(env))).toBe("<secret> and <secret> and <secret> and <secret>");
  });

  it("hides System 1's address whole, as its errors quote it: without a user name, password or query", () => {
    const secrets = secretsOf({ SYSTEM1_URL: "https://user:password@gpu.internal:8000/v1/systemone?key=x" });
    expect(scrub("https://gpu.internal:8000/v1/systemone: fetch failed", secrets)).toBe("<secret>: fetch failed");
  });

  it("hides the host and port a refused connection quotes", () => {
    const secrets = secretsOf({ SYSTEM1_URL: "http://10.1.2.3:8000/v1/systemone" });
    expect(scrub("http://10.1.2.3:8000/v1/systemone: fetch failed: connect ECONNREFUSED 10.1.2.3:8000", secrets)).toBe(
      "<secret>: fetch failed: connect ECONNREFUSED <secret>",
    );
  });

  it("hides the host name a failed lookup quotes", () => {
    const secrets = secretsOf({ SYSTEM1_URL: "https://gpu.internal:8000/v1/systemone" });
    expect(scrub("fetch failed: getaddrinfo ENOTFOUND gpu.internal", secrets)).toBe(
      "fetch failed: getaddrinfo ENOTFOUND <secret>",
    );
  });

  it("hides a longer secret before a part of it", () => {
    const secrets = secretsOf({
      SYSTEM2_API_KEY: "sk-or-v1-short",
      SYSTEM1_URL: "https://gpu.internal:8000/v1/systemone",
    });
    expect(secrets).toEqual([
      "https://gpu.internal:8000/v1/systemone",
      "gpu.internal:8000",
      "sk-or-v1-short",
      "gpu.internal",
    ]);
  });

  it("does not hide the host of a System 1 on this machine, only its whole address", () => {
    for (const host of ["localhost:8000", "127.0.0.1:8000", "[::1]:8000"]) {
      const address = `http://${host}/v1/systemone`;
      const secrets = secretsOf({ SYSTEM1_URL: address });
      expect(secrets).toEqual([address]);
      const said = `connect ECONNREFUSED ${host}; the facade's bridge is on 127.0.0.1`;
      expect(scrub(said, secrets)).toBe(said);
    }
  });

  it("does not hide a placeholder shorter than a real secret", () => {
    const secrets = secretsOf({ SYSTEM2_API_KEY: "k", BROWSERBASE_API_KEY: "key", OPENAI_API_KEY: " sk " });
    expect(secrets).toEqual([]);
    expect(scrub("the key k", secrets)).toBe("the key k");
  });

  it("hides no address when SYSTEM1_URL is unset: System 1 is then at OpenRouter's", () => {
    expect(secretsOf({})).toEqual([]);
  });
});

describe("what a step of System 1 is told as", () => {
  it("an action: a tool call named for its operation, with the step's screenshot, counted", () => {
    const teller = new Teller(SERVER, BUDGET);
    expect(teller.step(step("CLICK 5", SHOT), 3)).toEqual({
      events: [
        words(`CLICK 5: ${OPTION_WORDS}`),
        {
          type: "tool_call",
          id: "4",
          name: "click",
          server: SERVER,
          args: { option: "CLICK 5", element: OPTION_WORDS, url: PAGE_URL },
        },
        {
          type: "tool_result",
          id: "4",
          name: "click",
          server: SERVER,
          ok: true,
          text: JSON.stringify({ url: PAGE_URL, state: PAGE_STATE, note: null }),
          images: [IMAGE],
          structured: null,
        },
      ],
      counted: true,
    });
    expect(teller.imagesTold).toEqual({ tools: 0, steps: 1, starts: 0, done: 0 });
    expect(teller.steps).toEqual([{ n: 1, key: "CLICK 5", element: OPTION_WORDS, url: PAGE_URL, note: null }]);
  });

  it("DONE with its screenshot: a done call with the page and its screenshot, counted", () => {
    const teller = new Teller(SERVER, BUDGET);
    expect(teller.step(step("DONE", SHOT, "the book's page is open"), 1)).toEqual({
      events: [
        { type: "tool_call", id: "2", name: "done", server: SERVER, args: { option: "DONE", url: PAGE_URL } },
        {
          type: "tool_result",
          id: "2",
          name: "done",
          server: SERVER,
          ok: true,
          text: JSON.stringify({ url: PAGE_URL, state: PAGE_STATE, note: "the book's page is open" }),
          images: [IMAGE],
          structured: null,
        },
      ],
      counted: true,
    });
    expect(teller.imagesTold).toEqual({ tools: 0, steps: 0, starts: 0, done: 1 });
    expect(teller.steps).toEqual([{ n: 1, key: "DONE", element: "", url: PAGE_URL, note: "the book's page is open" }]);
  });

  it("DONE as a call 6 times at most, then in words", () => {
    const teller = new Teller(SERVER, BUDGET);
    const told = Array.from({ length: 7 }, (_, calls) => teller.step(step("DONE", SHOT), calls));
    expect(told.map((each) => each.counted)).toEqual([true, true, true, true, true, true, false]);
    expect(told.at(-1)?.events).toEqual([words("DONE")]);
    expect(teller.imagesTold.done).toBe(6);
  });

  it("DONE as a call only while the budget holds more than its reserve past it", () => {
    // A budget of 10 keeps 2 calls back for the answer: a DONE may be the 7th call, not the 8th.
    expect(new Teller(SERVER, 10).step(step("DONE", SHOT), 6).counted).toBe(true);
    const late = new Teller(SERVER, 10);
    expect(late.step(step("DONE", SHOT), 7)).toEqual({ events: [words("DONE")], counted: false });
    expect(late.imagesTold.done).toBe(0);
  });

  it("DONE without a screenshot, and an ending, in words only", () => {
    const teller = new Teller(SERVER, BUDGET);
    expect(teller.step(step("DONE"), 1)).toEqual({ events: [words("DONE")], counted: false });
    expect(teller.step(step("BLOCKED", SHOT, "the site refused the browser"), 1)).toEqual({
      events: [words("BLOCKED (the site refused the browser)")],
      counted: false,
    });
    expect(teller.imagesTold).toEqual({ tools: 0, steps: 0, starts: 0, done: 0 });
    expect(teller.steps.map((row) => row.key)).toEqual(["DONE", "BLOCKED"]);
  });
});

describe("what a tool call of System 2's is told as", () => {
  it("the read of the start page into the task: a read_page call with the page's text, counted", () => {
    const teller = new Teller(SERVER, BUDGET);
    const page = `Books (${PAGE_URL})\n\n[2] link: ${OPTION_WORDS}`;
    expect(teller.tool({ name: tools.READ, args: {}, ok: true, text: page, start: true }, 1)).toEqual({
      events: [
        { type: "tool_call", id: "2", name: "read_page", server: SERVER, args: {} },
        {
          type: "tool_result",
          id: "2",
          name: "read_page",
          server: SERVER,
          ok: true,
          text: page,
          images: [],
          structured: null,
        },
      ],
      counted: true,
    });
    expect(teller.imagesTold).toEqual({ tools: 0, steps: 0, starts: 1, done: 0 });
  });

  it("a show: a call with the page's screenshot, counted", () => {
    const teller = new Teller(SERVER, BUDGET);
    const shown: ToolEvent = {
      name: tools.SHOW,
      args: { text: "£51.77" },
      ok: true,
      text: "In view: £51.77",
      image: { bytes: SHOT, mimeType: "image/jpeg" },
    };
    const told = teller.tool(shown, 5);
    expect(told.counted).toBe(true);
    expect(told.events).toEqual([
      { type: "tool_call", id: "6", name: "show", server: SERVER, args: { text: "£51.77" } },
      expect.objectContaining({ type: "tool_result", id: "6", ok: true, images: [IMAGE] }),
    ]);
    expect(teller.imagesTold).toEqual({ tools: 1, steps: 0, starts: 0, done: 0 });
  });

  it("run_browser_agent's report in words, and finish not at all: neither is a call", () => {
    const teller = new Teller(SERVER, BUDGET);
    const ran: ToolEvent = {
      name: tools.RUN,
      args: { goal: "Open the book" },
      ok: true,
      text: "done: the book's page\nThe page now: Books",
    };
    expect(teller.tool(ran, 3)).toEqual({
      events: [words("run_browser_agent: Open the book → done: the book's page")],
      counted: false,
    });
    const finished: ToolEvent = { name: tools.FINISH, args: { answer: "£51.77" }, ok: true, text: "finished" };
    expect(teller.tool(finished, 3)).toEqual({ events: [], counted: false });
  });

  it("a call that did not go through: in words, not counted", () => {
    const teller = new Teller(SERVER, BUDGET);
    const failed: ToolEvent = { name: tools.CLICK, args: { n: 99 }, ok: false, text: "error: there is no element 99" };
    expect(teller.tool(failed, 3)).toEqual({
      events: [words("click not done: error: there is no element 99")],
      counted: false,
    });
    expect(teller.imagesTold).toEqual({ tools: 0, steps: 0, starts: 0, done: 0 });
  });
});

describe("the controller's share of the budget", () => {
  it("leaves the budget room for the calls told before it, the evidence and a reserve", () => {
    const actions = browserActionsFor(BUDGET, CALLS_BEFORE);
    expect(actions).toBe(91);
    // Every call that can be told, its own and the evidence, stays within the budget, one call to spare.
    expect(CALLS_BEFORE + START_READS + DONE_TOLD_MOST + actions).toBeLessThan(BUDGET);
  });

  it("gives no browser action, not fewer than none, when the budget is too small", () => {
    expect(browserActionsFor(SMALL_BUDGET, CALLS_BEFORE)).toBe(0);
  });
});
