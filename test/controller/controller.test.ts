import { describe, expect, it } from "vitest";
import type { ComparedPage, ManualAction, RunControls, RunInput, RunResult, StepRecord } from "../../src/index.ts";
import type { AskTurn, ChatModel, ToolSpec, Turn } from "./chat.ts";
import type { ControllerBrowser, ToolEvent } from "./controller.ts";
import { comparedLines, control, trimHistory } from "./controller.ts";

const MODEL: ChatModel = { model: "test-model" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

/** A turn that calls the given tools, in order. */
function calls(...made: [string, object][]): Turn {
  return {
    message: { role: "assistant", content: null },
    text: "",
    calls: made.map(([name, args], i) => ({ id: `c${i}`, name, arguments: JSON.stringify(args) })),
    usage: { input: 10, output: 2 },
  };
}

function words(text: string): Turn {
  return { message: { role: "assistant", content: text }, text, calls: [], usage: { input: 10, output: 2 } };
}

/** Asks the turns in order and keeps what each was asked with. */
function scripted(turns: Turn[]): { ask: AskTurn; asked: { messages: unknown[]; tools: readonly ToolSpec[] }[] } {
  const asked: { messages: unknown[]; tools: readonly ToolSpec[] }[] = [];
  const ask: AskTurn = async (_model, messages, tools) => {
    asked.push({ messages: [...messages], tools });
    const turn = turns.shift();
    if (!turn) throw new Error("no more turns");
    return turn;
  };
  return { ask, asked };
}

function result(status: RunResult["status"], steps: number): RunResult {
  return {
    status,
    detail: "",
    url: "https://site.test/",
    title: "Site",
    steps,
    seconds: 1,
    actions: [],
    recent: [],
    page: ["1 link Home"],
  };
}

class FakeBrowser implements ControllerBrowser {
  runs: RunInput[] = [];
  acted: ManualAction[] = [];
  opened: string[] = [];
  /** How many steps a run takes; it ends early when stopped. */
  stepsPerRun = 2;

  url(): string {
    return "https://site.test/";
  }
  async open(url: string): Promise<void> {
    this.opened.push(url);
  }
  async run(input: RunInput, controls: RunControls): Promise<RunResult> {
    this.runs.push(input);
    let steps = 0;
    while (steps < this.stepsPerRun && !controls.signal?.aborted) {
      steps++;
      controls.onStep?.({
        step: steps,
        url: "https://site.test/",
        state: "s",
        requests: [],
        key: "CLICK 1",
        note: undefined,
      } as StepRecord);
    }
    return result(controls.signal?.aborted ? "interrupted" : "done", steps);
  }
  async read(): Promise<{ url: string; title: string; lines: string[] }> {
    return { url: "https://site.test/", title: "Site", lines: ["1 link Home", "2 button Search"] };
  }
  async act(action: ManualAction): Promise<string> {
    this.acted.push(action);
    return `${action.kind}: done`;
  }
  async screenshot(): Promise<Uint8Array | undefined> {
    return JPEG;
  }
}

function toolTexts(messages: unknown[]): string[] {
  return messages
    .filter((m) => (m as { role?: string }).role === "tool")
    .map((m) => String((m as { content: unknown }).content));
}

describe("control", () => {
  it("hands a goal to the decision model and answers with finish", async () => {
    const browser = new FakeBrowser();
    const { ask } = scripted([
      calls([
        "run_browser_agent",
        { goal: "Search results for shoes", field_values: [{ name: "search", text: "shoes" }] },
      ]),
      calls(["finish", { answer: "42 results" }]),
    ]);
    const done = await control(browser, "How many shoes?", { model: MODEL, ask });
    expect(done).toMatchObject({ answer: "42 results", answered: true, end: "finished", turns: 2, manualActions: 0 });
    expect(browser.runs).toEqual([{ goal: "Search results for shoes", values: { search: "shoes" } }]);
    expect(done.runs).toHaveLength(1);
    expect(done.browserActions).toBe(2);
    expect(done.usage).toEqual({ input: 20, output: 4 });
  });

  it("refuses actions by hand past the task's limit", async () => {
    const browser = new FakeBrowser();
    const { ask, asked } = scripted([
      calls(["click", { element: 1 }], ["click", { element: 2 }], ["click", { element: 3 }]),
      calls(["finish", { answer: "ok" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, maxManualActions: 2 });
    expect(browser.acted).toEqual([
      { kind: "click", element: 1 },
      { kind: "click", element: 2 },
    ]);
    expect(toolTexts(asked[1]!.messages)[2]).toContain("actions by hand of this task are used");
  });

  it("leaves only finish once the browser actions are spent", async () => {
    const browser = new FakeBrowser();
    const { ask, asked } = scripted([
      calls(["read_page", {}], ["read_page", {}], ["read_page", {}]),
      calls(["finish", { answer: "from what I read" }]),
    ]);
    const done = await control(browser, "t", { model: MODEL, ask, maxBrowserActions: 3 });
    expect(done.browserActions).toBe(3);
    expect(asked[1]!.tools.map((tool) => tool.name)).toEqual(["finish"]);
    expect(JSON.stringify(asked[1]!.messages.at(-1))).toContain("are spent");
    expect(done.answer).toBe("from what I read");
  });

  it("does not count a run's DONE or ending as a browser action", async () => {
    class JudgingRuns extends FakeBrowser {
      override async run(input: RunInput, controls: RunControls): Promise<RunResult> {
        this.runs.push(input);
        for (const key of ["CLICK 1", "FILL 2", "DONE", "BLOCKED"]) {
          controls.onStep?.({ step: 1, url: "https://site.test/", state: "s", requests: [], key, note: undefined });
        }
        return result("done", 4);
      }
    }
    const { ask } = scripted([calls(["run_browser_agent", { goal: "g" }]), calls(["finish", { answer: "a" }])]);
    const done = await control(new JudgingRuns(), "t", { model: MODEL, ask });
    expect(done.browserActions).toBe(2);
  });

  it("stops a run when the browser actions run out in it", async () => {
    const browser = new FakeBrowser();
    browser.stepsPerRun = 50;
    const { ask } = scripted([calls(["run_browser_agent", { goal: "g" }]), calls(["finish", { answer: "a" }])]);
    const done = await control(browser, "t", { model: MODEL, ask, maxBrowserActions: 5 });
    expect(done.browserActions).toBe(5);
    expect(done.runs[0]?.status).toBe("interrupted");
  });

  it("nudges a turn in words once, then takes the words as the answer", async () => {
    const { ask, asked } = scripted([words("Let me think."), words("The answer is 7.")]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask });
    expect(done).toMatchObject({ answer: "The answer is 7.", answered: true, end: "words", turns: 2 });
    expect(JSON.stringify(asked[1]!.messages.at(-1))).toContain("Call a tool");
  });

  it("tells the controller whether anyone can be asked", async () => {
    const unattended = scripted([calls(["finish", { answer: "a" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask: unattended.ask, unattended: true });
    expect(JSON.stringify(unattended.asked[0]!.messages[0])).toContain("No one can be asked");
    const attended = scripted([calls(["finish", { answer: "a" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask: attended.ask });
    expect(JSON.stringify(attended.asked[0]!.messages[0])).toContain("Supply it from the task");
  });

  it("answers bad arguments with an error and goes on", async () => {
    const browser = new FakeBrowser();
    const { ask, asked } = scripted([
      calls(["click", { element: "the button" }], ["open", { url: "ftp://x" }], ["no_such_tool", {}]),
      calls(["finish", { answer: "a" }]),
    ]);
    const done = await control(browser, "t", { model: MODEL, ask });
    const texts = toolTexts(asked[1]!.messages);
    expect(texts.every((text) => text.startsWith("error:"))).toBe(true);
    expect(browser.acted).toEqual([]);
    expect(done.end).toBe("finished");
  });

  it("shows a model that reads images the screenshot after an action", async () => {
    const { ask, asked } = scripted([calls(["run_browser_agent", { goal: "g" }]), calls(["finish", { answer: "a" }])]);
    await control(new FakeBrowser(), "t", { model: { ...MODEL, vision: true }, ask });
    const last = JSON.stringify(asked[1]!.messages.at(-1));
    expect(last).toContain("image_url");
    expect(last).toContain("data:image/jpeg;base64,");
  });
});

describe("control's last word and its history", () => {
  it("asks again after empty turns, then asks for the last word with finish alone", async () => {
    const { ask, asked } = scripted([words(""), words(""), words(""), calls(["finish", { answer: "late but there" }])]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask });
    expect(done).toMatchObject({ answer: "late but there", answered: true, end: "words" });
    expect(asked[3]!.tools.map((tool) => tool.name)).toEqual(["finish"]);
  });

  it("asks for the last word when the turns run out", async () => {
    const { ask, asked } = scripted([
      calls(["read_page", {}]),
      calls(["read_page", {}]),
      calls(["finish", { answer: "a" }]),
    ]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask, maxTurns: 2 });
    expect(done).toMatchObject({ answer: "a", answered: true, end: "turns", turns: 3 });
    expect(asked[2]!.tools.map((tool) => tool.name)).toEqual(["finish"]);
  });

  it("stops a run near the deadline and asks for the answer with finish alone", async () => {
    /** A run that goes on until it is stopped. */
    class EndlessRuns extends FakeBrowser {
      override async run(input: RunInput, controls: RunControls): Promise<RunResult> {
        this.runs.push(input);
        await new Promise<void>((resolve) =>
          controls.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return result("interrupted", 0);
      }
    }
    const { ask, asked } = scripted([
      calls(["run_browser_agent", { goal: "g", field_values: [] }]),
      calls(["finish", { answer: "what was read" }]),
    ]);
    const deadline = Date.now() + 45_000 + 50; // the run is stopped 50 ms from now
    const done = await control(new EndlessRuns(), "t", { model: MODEL, ask, deadline });
    expect(done).toMatchObject({ answer: "what was read", answered: true, end: "time" });
    expect(asked[1]!.tools.map((tool) => tool.name)).toEqual(["finish"]);
  });

  it("asks a turn after actions by hand with the quick reasoning effort, and others with the model's own", async () => {
    const efforts: unknown[] = [];
    const turns = [
      calls(["click", { element: 2 }]),
      calls(["run_browser_agent", { goal: "g" }]),
      calls(["finish", { answer: "a" }]),
    ];
    const ask: AskTurn = async (model) => {
      efforts.push(model.reasoning);
      const turn = turns.shift();
      if (!turn) throw new Error("no more turns");
      return turn;
    };
    await control(new FakeBrowser(), "t", { model: { ...MODEL, reasoning: "medium" }, ask, quickReasoning: "low" });
    expect(efforts).toEqual(["medium", "low", "medium"]);
  });

  it("keeps the latest tool answers whole and the latest screenshots only", () => {
    const long = (n: number) => `page ${n}\n${"x".repeat(2_000)}`;
    const shot = {
      role: "user",
      content: [
        { type: "text", text: "s" },
        { type: "image_url", image_url: { url: "data:," } },
      ],
    };
    const messages: unknown[] = [{ role: "system", content: "s" }];
    for (let n = 1; n <= 5; n++) messages.push({ role: "tool", tool_call_id: `c${n}`, content: long(n) }, { ...shot });
    trimHistory(messages);
    const tools = messages
      .filter((m) => (m as { role: string }).role === "tool")
      .map((m) => String((m as { content: string }).content));
    expect(tools.map((t) => t.length > 1_000)).toEqual([false, false, true, true, true]);
    expect(tools[0]).toContain("page 1");
    expect(messages.filter((m) => Array.isArray((m as { content: unknown }).content))).toHaveLength(2);
  });
});

describe("control's answer checks, shows and time", () => {
  /** A browser whose page holds some words a show can scroll to. */
  class Revealing extends FakeBrowser {
    revealed: string[] = [];
    pageWords = ["$98.29"];
    async reveal(text: string): Promise<boolean> {
      this.revealed.push(text);
      return this.pageWords.includes(text);
    }
  }

  it("answers a finish with values no page showed once, then takes the next finish", async () => {
    const { ask, asked } = scripted([
      calls(["read_page", {}]),
      calls(["finish", { answer: "It costs $216.00 at 3 stores" }]),
      calls(["finish", { answer: "It costs $216.00 (4 × $54 shown)" }]),
    ]);
    const done = await control(new FakeBrowser(), "Find the price", { model: MODEL, ask });
    expect(done).toMatchObject({ answer: "It costs $216.00 (4 × $54 shown)", end: "finished", turns: 3 });
    expect(toolTexts(asked[2]!.messages)[1]).toContain('no page you read showed "$216.00"');
  });

  it("counts the task's own words and every page read as shown", async () => {
    const { ask } = scripted([
      calls(["read_page", {}]),
      calls(["finish", { answer: "Under the $1,300 limit; the page lists Search" }]),
    ]);
    const done = await control(new FakeBrowser(), "Find a flat under $1,300", { model: MODEL, ask });
    expect(done).toMatchObject({ end: "finished", turns: 2 });
  });

  it("shows a text without counting it as an action by hand", async () => {
    const browser = new Revealing();
    const { ask } = scripted([calls(["show", { text: "$98.29" }]), calls(["finish", { answer: "done" }])]);
    const done = await control(browser, "t", { model: MODEL, ask, maxManualActions: 0 });
    expect(browser.revealed).toEqual(["$98.29"]);
    expect(done.manualActions).toBe(0);
  });

  it("scrolls to the answer's amounts on the open page as it finishes, and tells each as a show", async () => {
    const browser = new Revealing();
    browser.pageWords = ["$98.29", "$12.50"];
    const heard: string[] = [];
    const { ask } = scripted([
      calls(["run_browser_agent", { goal: "g" }]),
      calls(["finish", { answer: "Brother $98.29, Office Depot $12.50, 3,000 pages" }]),
    ]);
    // The run's page holds the values, so the finish goes through at once.
    browser.run = async (input, controls) => ({
      ...(await FakeBrowser.prototype.run.call(browser, input, controls)),
      page: ["$98.29 $12.50 3000 pages"],
    });
    await control(browser, "t", {
      model: MODEL,
      ask,
      onTool: (event) => {
        if (event.name === "show") heard.push(String(event.args.text));
      },
    });
    expect(browser.revealed).toEqual(["$12.50", "$98.29"]);
    expect(heard).toEqual(["$12.50", "$98.29"]);
  });

  it("ends each turn's last tool answer with the time used and left when the task has a deadline", async () => {
    const { ask, asked } = scripted([calls(["read_page", {}]), calls(["finish", { answer: "ok" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask, deadline: Date.now() + 600_000 });
    expect(toolTexts(asked[1]!.messages)[0]).toMatch(/\(time: \d+ s used, \d+ s left before the answer is due\)$/);
    expect(String((asked[0]!.messages[0] as { content: string }).content)).toContain("## Time");
  });
});

describe("control's budget as its caller counts it", () => {
  it("offers finish alone, and shows nothing more, once the caller counts the actions spent", async () => {
    let told = 0;
    class Counting extends FakeBrowser {
      revealed: string[] = [];
      async reveal(text: string): Promise<boolean> {
        this.revealed.push(text);
        told++;
        return true;
      }
    }
    const browser = new Counting();
    const { ask, asked } = scripted([
      calls(["show", { text: "$1.00" }]),
      calls(["show", { text: "$2.00" }]),
      calls(["finish", { answer: "$1.00" }]),
    ]);
    const done = await control(browser, "t", { model: MODEL, ask, spent: () => told >= 1 });
    expect(done).toMatchObject({ answer: "$1.00", answered: true });
    expect(browser.revealed).toEqual(["$1.00"]);
    expect(asked[1]!.tools.map((tool) => tool.name)).toEqual(["finish"]);
  });
});

describe("control with actions by hand after failures only", () => {
  /** A browser whose runs end as the queue says. */
  class Endings extends FakeBrowser {
    endings: RunResult["status"][] = [];
    override async run(input: RunInput): Promise<RunResult> {
      this.runs.push(input);
      return result(this.endings.shift() ?? "done", 1);
    }
  }

  it("offers no action by hand before a run has stopped short, and refuses one called anyway", async () => {
    const browser = new Endings();
    const { ask, asked } = scripted([calls(["click", { element: 1 }]), calls(["finish", { answer: "ok" }])]);
    await control(browser, "t", { model: MODEL, ask, handsAfterFailure: 3 });
    expect(asked[0]!.tools.map((tool) => tool.name)).not.toContain("click");
    expect(browser.acted).toEqual([]);
    expect(toolTexts(asked[1]!.messages)[0]).toContain("offered only right after a run stops short");
    expect(String((asked[0]!.messages[0] as { content: string }).content)).toContain(
      "The decision model does every action",
    );
  });

  it("opens a few actions by hand after a run stops short, and closes them at the next run", async () => {
    const browser = new Endings();
    browser.endings = ["looping", "done"];
    const { ask, asked } = scripted([
      calls(["run_browser_agent", { goal: "g" }]),
      calls(["click", { element: 1 }], ["click", { element: 2 }], ["click", { element: 3 }]),
      calls(["run_browser_agent", { goal: "g2" }]),
      calls(["click", { element: 4 }]),
      calls(["finish", { answer: "ok" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, handsAfterFailure: 2 });
    expect(browser.acted).toEqual([
      { kind: "click", element: 1 },
      { kind: "click", element: 2 },
    ]);
    expect(asked[1]!.tools.map((tool) => tool.name)).toContain("click");
    expect(toolTexts(asked[1]!.messages)[0]).toContain("Actions by hand are open for 2 actions");
    expect(asked[4]!.tools.map((tool) => tool.name)).not.toContain("click");
  });
});

describe("control's choices for fewer turns", () => {
  /** A browser whose page holds some words a show can scroll to, and as many lines as asked. */
  class Shows extends FakeBrowser {
    revealed: string[] = [];
    pageWords = ["$98.29", "$12.50"];
    lineCount = 2;
    reads = 0;
    async reveal(text: string): Promise<boolean> {
      this.revealed.push(text);
      return this.pageWords.includes(text);
    }
    override async read(): Promise<{ url: string; title: string; lines: string[] }> {
      this.reads++;
      const lines = Array.from({ length: this.lineCount }, (_, i) => `${i + 1} text line ${i + 1}`);
      return { url: "https://site.test/", title: "Site", lines };
    }
  }

  const systemOf = (asked: { messages: unknown[] }[]): string =>
    String((asked[0]!.messages[0] as { content: string }).content);
  const firstOf = (asked: { messages: unknown[] }[]): string =>
    String((asked[0]!.messages[1] as { content: string }).content);
  const showSpec = (tools: readonly ToolSpec[]): string => JSON.stringify(tools.find((tool) => tool.name === "show"));

  it("shows several texts in one call, hears each one found as a show of its own, and says which were found", async () => {
    const browser = new Shows();
    const heard: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
    const { ask, asked } = scripted([
      calls(["show", { texts: ["$98.29", "$5.00", "$12.50"] }]),
      calls(["finish", { answer: "done" }]),
    ]);
    const done = await control(browser, "t", {
      model: MODEL,
      ask,
      multiShow: true,
      showHoldMs: 0,
      onTool: ({ name, args, ok }) => {
        if (name === "show") heard.push({ name, args, ok });
      },
    });
    expect(browser.revealed).toEqual(["$98.29", "$5.00", "$12.50"]);
    expect(heard).toEqual([
      { name: "show", args: { text: "$98.29" }, ok: true },
      { name: "show", args: { text: "$12.50" }, ok: true },
    ]);
    expect(toolTexts(asked[1]!.messages)[0]).toBe(
      '"$98.29" is in view\n"$5.00" is not on this page as it reads now\n"$12.50" is in view',
    );
    expect(done.browserActions).toBe(3);
    expect(showSpec(asked[0]!.tools)).toContain('"texts"');
    expect(systemOf(asked)).toContain("show them all in one show, in the same turn as the call that leaves the page");
    expect(systemOf(asked)).toContain("If the show misses a text, that call is left undone");
    expect(systemOf(asked)).toContain("only shows and read_page go before another call of the same turn");
  });

  it("takes show's one text with several texts offered, and hears a show that found none once, as not done", async () => {
    const browser = new Shows();
    const heard: { name: string; ok: boolean }[] = [];
    const { ask } = scripted([
      calls(["show", { text: "$98.29" }]),
      calls(["show", { texts: ["$1.00", "$2.00"] }]),
      calls(["finish", { answer: "done" }]),
    ]);
    await control(browser, "t", {
      model: MODEL,
      ask,
      multiShow: true,
      showHoldMs: 0,
      onTool: ({ name, ok }) => {
        if (name === "show") heard.push({ name, ok });
      },
    });
    expect(browser.revealed).toEqual(["$98.29", "$1.00", "$2.00"]);
    expect(heard).toEqual([
      { name: "show", ok: true },
      { name: "show", ok: false },
    ]);
  });

  it("stops a show of several texts once the caller counts the actions spent", async () => {
    const browser = new Shows();
    let told = 0;
    const { ask, asked } = scripted([
      calls(["show", { texts: ["$98.29", "$12.50"] }]),
      calls(["finish", { answer: "$98.29" }]),
    ]);
    await control(browser, "t", {
      model: MODEL,
      ask,
      multiShow: true,
      showHoldMs: 0,
      spent: () => told >= 1,
      onTool: (event) => {
        if (event.ok) told++;
      },
    });
    expect(browser.revealed).toEqual(["$98.29"]);
    expect(toolTexts(asked[1]!.messages)[0]).toContain("are spent");
  });

  it("keeps show to one text, and the prompt's shows apart, when several texts are not asked for", async () => {
    const { ask, asked } = scripted([calls(["finish", { answer: "a" }])]);
    await control(new Shows(), "t", { model: MODEL, ask });
    expect(showSpec(asked[0]!.tools)).not.toContain('"texts"');
    expect(systemOf(asked)).toContain("several shows can go in one turn");
    expect(systemOf(asked)).not.toContain("left undone");
  });

  it("answers an open with the page up to read_page's lines when asked, and its first lines otherwise", async () => {
    const opening = async (openFullPage: boolean) => {
      const browser = new Shows();
      browser.lineCount = 100;
      const { ask, asked } = scripted([
        calls(["open", { url: "https://a.test/" }]),
        calls(["finish", { answer: "a" }]),
      ]);
      await control(browser, "t", { model: MODEL, ask, openFullPage });
      return { answer: toolTexts(asked[1]!.messages)[0]!, tools: asked[0]!.tools };
    };
    const full = await opening(true);
    expect(full.answer).toContain("100 text line 100");
    expect(full.answer).not.toContain("more lines");
    expect(JSON.stringify(full.tools.find((tool) => tool.name === "open"))).toContain("as read_page gives it");
    const first = await opening(false);
    expect(first.answer).not.toContain("100 text line 100");
    expect(first.answer).toContain("(40 more lines)");
  });

  it("stops offering actions by hand once they are used, when asked, and refuses one called anyway", async () => {
    const browser = new FakeBrowser();
    const { ask, asked } = scripted([
      calls(["click", { element: 1 }]),
      calls(["click", { element: 2 }]),
      calls(["finish", { answer: "ok" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, maxManualActions: 1, hideSpentHands: true });
    expect(asked[0]!.tools.map((tool) => tool.name)).toContain("click");
    expect(asked[1]!.tools.map((tool) => tool.name)).not.toContain("click");
    expect(asked[1]!.tools.map((tool) => tool.name)).toContain("read_page");
    expect(browser.acted).toEqual([{ kind: "click", element: 1 }]);
    expect(toolTexts(asked[2]!.messages)[1]).toContain("actions by hand of this task are used");
  });

  it("keeps offering actions by hand once they are used, when not asked to hide them", async () => {
    const { ask, asked } = scripted([calls(["click", { element: 1 }]), calls(["finish", { answer: "ok" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask, maxManualActions: 1 });
    expect(asked[1]!.tools.map((tool) => tool.name)).toContain("click");
  });

  it("gives the start page as read in the task's message, without counting the read, when asked", async () => {
    const browser = new Shows();
    browser.lineCount = 500;
    const { ask, asked } = scripted([calls(["finish", { answer: "a" }])]);
    const done = await control(browser, "t", { model: MODEL, ask, startPageInTask: true });
    expect(browser.reads).toBe(1);
    expect(firstOf(asked)).toContain("The page that is open, as read_page reads it: Site (https://site.test/)");
    expect(firstOf(asked)).toContain("400 text line 400\n(100 more lines)");
    expect(systemOf(asked)).toContain("it is already read");
    expect(done.browserActions).toBe(0);
  });

  it("tells the start page's read to onTool, marked as the start, when it reads it", async () => {
    const told: ToolEvent[] = [];
    const { ask } = scripted([calls(["finish", { answer: "a" }])]);
    await control(new Shows(), "t", { model: MODEL, ask, startPageInTask: true, onTool: (event) => told.push(event) });
    expect(told[0]).toMatchObject({ name: "read_page", args: {}, ok: true, start: true });
    expect(told[0]!.text).toContain("Site (https://site.test/)");
    const quiet: ToolEvent[] = [];
    const off = scripted([calls(["finish", { answer: "a" }])]);
    await control(new Shows(), "t", { model: MODEL, ask: off.ask, onTool: (event) => quiet.push(event) });
    expect(quiet.some((event) => event.start === true)).toBe(false);
  });

  it("gives the start page's address alone in the task's message when not asked to read it", async () => {
    const browser = new Shows();
    const { ask, asked } = scripted([calls(["finish", { answer: "a" }])]);
    await control(browser, "t", { model: MODEL, ask });
    expect(browser.reads).toBe(0);
    expect(firstOf(asked)).toContain("The page that is open: https://site.test/");
    expect(systemOf(asked)).not.toContain("it is already read");
  });

  it("tells the controller that opens and actions by hand answer with the page, when asked", async () => {
    const on = scripted([calls(["finish", { answer: "a" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask: on.ask, pageInAnswers: true });
    expect(systemOf(on.asked)).toContain("read_page is only for a page that has changed since");
    const off = scripted([calls(["finish", { answer: "a" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask: off.ask });
    expect(systemOf(off.asked)).not.toContain("read_page is only for a page that has changed since");
  });

  it("keeps as many whole answers and screenshots as asked", () => {
    const long = (n: number) => `page ${n}\n${"x".repeat(2_000)}`;
    const shot = {
      role: "user",
      content: [
        { type: "text", text: "s" },
        { type: "image_url", image_url: { url: "data:," } },
      ],
    };
    const messages: unknown[] = [{ role: "system", content: "s" }];
    for (let n = 1; n <= 5; n++) messages.push({ role: "tool", tool_call_id: `c${n}`, content: long(n) }, { ...shot });
    trimHistory(messages, { answers: 1, shots: 4 });
    const tools = messages
      .filter((m) => (m as { role: string }).role === "tool")
      .map((m) => String((m as { content: string }).content));
    expect(tools.map((t) => t.length > 1_000)).toEqual([false, false, false, false, true]);
    expect(messages.filter((m) => Array.isArray((m as { content: unknown }).content))).toHaveLength(4);
  });

  it("passes the screenshots to keep on to the history's trimming", async () => {
    const { ask, asked } = scripted([calls(["run_browser_agent", { goal: "g" }]), calls(["finish", { answer: "a" }])]);
    await control(new FakeBrowser(), "t", { model: { ...MODEL, vision: true }, ask, keepShots: 0 });
    expect(JSON.stringify(asked[1]!.messages)).not.toContain("image_url");
  });

  it("asks a turn after shows, opens and reads with the quick effort when asked, and with the model's own otherwise", async () => {
    const efforts = async (quickAfter: "hands" | "mechanical" | undefined): Promise<unknown[]> => {
      const asked: unknown[] = [];
      const turns = [
        calls(["show", { text: "$98.29" }], ["read_page", {}]),
        calls(["open", { url: "https://a.test/" }], ["click", { element: 1 }]),
        calls(["show", { text: "$5.00" }]),
        calls(["run_browser_agent", { goal: "g" }]),
        calls(["finish", { answer: "a" }]),
      ];
      const ask: AskTurn = async (model) => {
        asked.push(model.reasoning);
        const turn = turns.shift();
        if (!turn) throw new Error("no more turns");
        return turn;
      };
      await control(new Shows(), "t", {
        model: { ...MODEL, reasoning: "medium" },
        ask,
        quickReasoning: "low",
        ...(quickAfter ? { quickAfter } : {}),
      });
      return asked;
    };
    // The show of $5.00 finds nothing: the turn after it plans again.
    expect(await efforts("mechanical")).toEqual(["medium", "low", "low", "medium", "medium"]);
    expect(await efforts(undefined)).toEqual(["medium", "medium", "medium", "medium", "medium"]);
    expect(await efforts("hands")).toEqual(["medium", "medium", "medium", "medium", "medium"]);
  });

  it("holds the page on each text a show found, before its next text and before the turn's next call", async () => {
    const hold = 60;
    class Timed extends Shows {
      at: [string, number][] = [];
      override async reveal(text: string): Promise<boolean> {
        this.at.push([text, Date.now()]);
        return super.reveal(text);
      }
      override async open(url: string): Promise<void> {
        this.at.push([url, Date.now()]);
        return super.open(url);
      }
    }
    const browser = new Timed();
    const { ask } = scripted([
      calls(["show", { texts: ["$98.29", "$12.50"] }], ["open", { url: "https://b.test/" }]),
      calls(["finish", { answer: "done" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, multiShow: true, showHoldMs: hold });
    expect(browser.at.map(([what]) => what)).toEqual(["$98.29", "$12.50", "https://b.test/"]);
    // A timer's own clock may run a millisecond ahead of Date.now.
    for (let i = 1; i < browser.at.length; i++) {
      expect(browser.at[i]![1] - browser.at[i - 1]![1]).toBeGreaterThanOrEqual(hold - 2);
    }
  });

  it("leaves a turn's calls undone after a show that missed a text and after a call that changed the page", async () => {
    const browser = new Shows();
    const heard: { name: string; ok: boolean }[] = [];
    const asked: { reasoning: unknown; messages: unknown[] }[] = [];
    const turns = [
      calls(["show", { texts: ["$98.29", "Rating 4.6"] }], ["open", { url: "https://b.test/" }]),
      calls(
        ["show", { texts: ["$98.29"] }],
        ["open", { url: "https://c.test/" }],
        ["click", { element: 2 }],
        ["open", { url: "https://d.test/" }],
      ),
      calls(["finish", { answer: "done" }]),
    ];
    const ask: AskTurn = async (model, messages) => {
      asked.push({ reasoning: model.reasoning, messages: [...messages] });
      const turn = turns.shift();
      if (!turn) throw new Error("no more turns");
      return turn;
    };
    await control(browser, "t", {
      model: { ...MODEL, reasoning: "medium" },
      ask,
      multiShow: true,
      showHoldMs: 0,
      quickReasoning: "low",
      quickAfter: "mechanical",
      onTool: ({ name, ok }) => heard.push({ name, ok }),
    });
    expect(browser.revealed).toEqual(["$98.29", "Rating 4.6", "$98.29"]);
    expect(browser.opened).toEqual(["https://c.test/"]);
    expect(browser.acted).toEqual([]);
    const answers = toolTexts(asked[2]!.messages);
    expect(answers[0]).toBe('"$98.29" is in view\n"Rating 4.6" is not on this page as it reads now');
    expect(answers.map((answer) => answer.startsWith("Left undone"))).toEqual([false, true, false, false, true, true]);
    expect(heard).toEqual([
      { name: "show", ok: true },
      { name: "open", ok: false },
      { name: "show", ok: true },
      { name: "open", ok: true },
      { name: "click", ok: false },
      { name: "open", ok: false },
      { name: "finish", ok: true },
    ]);
    // A show that missed a text, and a turn with calls left undone, have the next turn plan at the model's own effort.
    expect(asked.map((each) => each.reasoning)).toEqual(["medium", "medium", "medium"]);
  });

  it("carries out every call of a turn, as before, when show takes one text", async () => {
    const browser = new Shows();
    const { ask } = scripted([
      calls(["show", { text: "Rating 4.6" }], ["open", { url: "https://b.test/" }], ["click", { element: 2 }]),
      calls(["finish", { answer: "done" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask });
    expect(browser.opened).toEqual(["https://b.test/"]);
    expect(browser.acted).toEqual([{ kind: "click", element: 2 }]);
  });

  it("keeps the latest turn's answers whole, however few are kept, when a number is given", async () => {
    const browser = new Shows();
    browser.lineCount = 100;
    const { ask, asked } = scripted([
      calls(["read_page", {}]),
      calls(["read_page", {}], ["click", { element: 2 }]),
      calls(["finish", { answer: "a" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, keepFullAnswers: 0 });
    const whole = (i: number) => toolTexts(asked[i]!.messages).map((answer) => answer.includes("100 text line 100"));
    expect(whole(1)).toEqual([true]);
    expect(whole(2)).toEqual([false, true, true]);
  });

  it("keeps the answers since the latest assistant message whole only when asked", () => {
    const long = (n: number) => ({ role: "tool", tool_call_id: `c${n}`, content: `page ${n}\n${"x".repeat(2_000)}` });
    const turn = () => [{ role: "assistant", content: null }, long(1), long(2), long(3)];
    const wholeOf = (messages: unknown[]) =>
      messages
        .filter((m) => (m as { role: string }).role === "tool")
        .map((m) => String((m as { content: string }).content).length > 1_000);
    const kept = turn();
    trimHistory(kept, { answers: 1, latestTurn: true });
    expect(wholeOf(kept)).toEqual([true, true, true]);
    const cut = turn();
    trimHistory(cut, { answers: 1 });
    expect(wholeOf(cut)).toEqual([false, false, true]);
  });

  it("refuses counts that are not whole numbers from 0", async () => {
    for (const given of [{ keepFullAnswers: Number.NaN }, { keepShots: -1 }, { showHoldMs: 1.5 }]) {
      const { ask } = scripted([calls(["finish", { answer: "a" }])]);
      await expect(control(new FakeBrowser(), "t", { model: MODEL, ask, ...given })).rejects.toThrow(
        "is a whole number from 0",
      );
    }
  });
});

describe("control's show evidence", () => {
  const SHOT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const EXCERPT_OF = (value: string) =>
    `"${value}" is in view on Shop:\ntext Price\ntext ${value}\n(https://shop.test/)`;

  /** A browser whose page holds some prices a show can scroll to, and that takes a screenshot a person can read. */
  class Evidence extends FakeBrowser {
    revealed: [string, number][] = [];
    /** Whether each show asked to scroll at once. */
    instant: (boolean | undefined)[] = [];
    pageWords = ["$98.29", "$12.50"];
    reads = 0;
    shots = 0;
    async reveal(text: string, instant?: boolean): Promise<boolean> {
      this.revealed.push([text, Date.now()]);
      this.instant.push(instant);
      return this.pageWords.includes(text);
    }
    override async read(): Promise<{ url: string; title: string; lines: string[] }> {
      this.reads++;
      const shown = this.revealed.at(-1)?.[0] ?? "";
      return {
        url: "https://shop.test/",
        title: "Shop",
        lines: ["page (scrolled 0/0px):", "  text Price", `  text ${shown}`],
      };
    }
    async readableScreenshot(): Promise<Uint8Array | undefined> {
      this.shots++;
      return SHOT;
    }
  }

  it("tells each text a show of several found with its screenshot and lines, without holding the page", async () => {
    const browser = new Evidence();
    const heard: ToolEvent[] = [];
    const { ask, asked } = scripted([
      calls(["show", { texts: ["$98.29", "$5.00", "$12.50"] }]),
      calls(["finish", { answer: "done" }]),
    ]);
    await control(browser, "t", {
      model: MODEL,
      ask,
      multiShow: true,
      showEvidence: true,
      onTool: (e) => heard.push(e),
    });
    const image = { bytes: SHOT, mimeType: "image/jpeg" };
    expect(heard.filter((event) => event.name === "show")).toEqual([
      { name: "show", args: { text: "$98.29" }, ok: true, text: EXCERPT_OF("$98.29"), image },
      { name: "show", args: { text: "$12.50" }, ok: true, text: EXCERPT_OF("$12.50"), image },
    ]);
    // The controller is answered as before; the hold multiShow has by default (1.5 s) is not waited.
    expect(toolTexts(asked[1]!.messages)[0]).toBe(
      '"$98.29" is in view\n"$5.00" is not on this page as it reads now\n"$12.50" is in view',
    );
    const [first, , last] = browser.revealed;
    expect(last![1] - first![1]).toBeLessThan(1_000);
    expect([browser.reads, browser.shots]).toEqual([2, 2]);
  });

  it("tells a show of one text with them in place of its answer, and a show that missed as before", async () => {
    const browser = new Evidence();
    const heard: ToolEvent[] = [];
    const { ask, asked } = scripted([
      calls(["show", { text: "$98.29" }], ["show", { text: "$5.00" }]),
      calls(["finish", { answer: "done" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, showEvidence: true, onTool: (e) => heard.push(e) });
    expect(heard.slice(0, 2)).toEqual([
      {
        name: "show",
        args: { text: "$98.29" },
        ok: true,
        text: EXCERPT_OF("$98.29"),
        image: { bytes: SHOT, mimeType: "image/jpeg" },
      },
      { name: "show", args: { text: "$5.00" }, ok: false, text: '"$5.00" is not on this page as it reads now' },
    ]);
    expect(toolTexts(asked[1]!.messages)).toEqual([
      '"$98.29" is in view',
      '"$5.00" is not on this page as it reads now',
    ]);
    expect([browser.reads, browser.shots]).toEqual([1, 1]);
  });

  it("tells the answer's values finish scrolls to with them", async () => {
    const browser = new Evidence();
    const heard: ToolEvent[] = [];
    const { ask } = scripted([calls(["read_page", {}]), calls(["finish", { answer: "Brother $98.29" }])]);
    browser.read = async () => ({
      url: "https://shop.test/",
      title: "Shop",
      lines: ["page (scrolled 0/0px):", "  text $98.29"],
    });
    await control(browser, "t", { model: MODEL, ask, showEvidence: true, onTool: (e) => heard.push(e) });
    const shows = heard.filter((event) => event.name === "show");
    expect(shows.map((event) => [event.text, event.image?.mimeType])).toEqual([
      ['"$98.29" is in view on Shop:\ntext $98.29\n(https://shop.test/)', "image/jpeg"],
    ]);
  });

  it("tells a show without a screenshot or lines that cannot be had, and with neither when not asked", async () => {
    const failing = new Evidence();
    failing.read = async () => {
      throw new Error("the page is gone");
    };
    failing.readableScreenshot = async () => {
      throw new Error("no screenshot");
    };
    const heard: ToolEvent[] = [];
    const failed = scripted([calls(["show", { text: "$98.29" }]), calls(["finish", { answer: "done" }])]);
    await control(failing, "t", { model: MODEL, ask: failed.ask, showEvidence: true, onTool: (e) => heard.push(e) });
    expect(heard[0]).toEqual({ name: "show", args: { text: "$98.29" }, ok: true, text: '"$98.29" is in view' });
    const plain = new Evidence();
    const told: ToolEvent[] = [];
    const { ask } = scripted([calls(["show", { texts: ["$98.29"] }]), calls(["finish", { answer: "done $12.50" }])]);
    await control(plain, "t $12.50", {
      model: MODEL,
      ask,
      multiShow: true,
      showHoldMs: 0,
      onTool: (e) => told.push(e),
    });
    expect(told.filter((event) => event.name === "show").map((event) => Object.keys(event))).toEqual([
      ["name", "args", "ok", "text"],
      ["name", "args", "ok", "text"],
    ]);
    expect([plain.reads, plain.shots]).toEqual([0, 0]);
  });

  it("scrolls at once to each text, of a show of one, of several and of finish, only with showEvidence", async () => {
    const shown = async (showEvidence: boolean, multiShow: boolean) => {
      const browser = new Evidence();
      const show = multiShow ? { texts: ["$98.29", "$5.00"] } : { text: "$98.29" };
      const { ask } = scripted([calls(["show", show]), calls(["finish", { answer: "Brother $12.50" }])]);
      await control(browser, "t $12.50", { model: MODEL, ask, multiShow, showEvidence, showHoldMs: 0 });
      return browser.instant;
    };
    expect(await shown(true, false)).toEqual([true, true]);
    expect(await shown(true, true)).toEqual([true, true, true]);
    expect(await shown(false, false)).toEqual([false, false]);
    expect(await shown(false, true)).toEqual([false, false, false]);
  });

  it("still holds the page on a show for showHoldMs when it is given", async () => {
    const hold = 60;
    const browser = new Evidence();
    const { ask } = scripted([calls(["show", { texts: ["$98.29", "$12.50"] }]), calls(["finish", { answer: "done" }])]);
    await control(browser, "t", { model: MODEL, ask, multiShow: true, showEvidence: true, showHoldMs: hold });
    const [first, second] = browser.revealed;
    // A timer's own clock may run a millisecond ahead of Date.now.
    expect(second![1] - first![1]).toBeGreaterThanOrEqual(hold - 2);
  });
});

describe("control's date and whole answer", () => {
  it("gives today's date in the first message only when asked", async () => {
    const first = (asked: { messages: unknown[] }[]) => String((asked[0]!.messages[1] as { content: unknown }).content);
    const plain = scripted([calls(["finish", { answer: "ok" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask: plain.ask });
    expect(first(plain.asked)).not.toContain("Today is");
    const dated = scripted([calls(["finish", { answer: "ok" }])]);
    await control(new FakeBrowser(), "t", { model: MODEL, ask: dated.ask, today: "Wednesday, 18 November 2026" });
    expect(first(dated.asked)).toContain("Today is Wednesday, 18 November 2026: dates in the task count from it.");
  });

  it("puts the words of the finishing turn before the answer only with wholeAnswer", async () => {
    const finishing = (): Turn => ({
      ...calls(["finish", { answer: "The total is in the table above." }]),
      text: "| Hotel | $108.87 |",
    });
    const plain = scripted([finishing()]);
    const kept = await control(new FakeBrowser(), "t", { model: MODEL, ask: plain.ask });
    expect(kept.answer).toBe("The total is in the table above.");
    expect(String((plain.asked[0]!.messages[0] as { content: unknown }).content)).not.toContain("all the person gets");
    const whole = scripted([finishing()]);
    const joined = await control(new FakeBrowser(), "t", { model: MODEL, ask: whole.ask, wholeAnswer: true });
    expect(joined.answer).toBe("| Hotel | $108.87 |\n\nThe total is in the table above.");
    expect(String((whole.asked[0]!.messages[0] as { content: unknown }).content)).toContain("all the person gets");
  });

  it("does not repeat words the answer already holds", async () => {
    const { ask } = scripted([
      { ...calls(["finish", { answer: "Hotel A is cheapest. Done." }]), text: "Hotel A is cheapest." },
    ]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask, wholeAnswer: true });
    expect(done.answer).toBe("Hotel A is cheapest. Done.");
  });
});

describe("control's persist", () => {
  const givingUp = () => calls(["finish", { answer: "I couldn't find the item on this site." }]);

  it("sends an answer that gives up back once, then takes the next finish", async () => {
    const { ask, asked } = scripted([givingUp(), calls(["read_page", {}]), givingUp()]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask, persist: true });
    expect(done).toMatchObject({ answer: "I couldn't find the item on this site.", end: "finished", turns: 3 });
    expect(toolTexts(asked[1]!.messages).at(-1)).toContain("Try another way first");
  });

  it("takes an answer that gives up at once without persist, or one that does not give up", async () => {
    const off = scripted([givingUp()]);
    expect((await control(new FakeBrowser(), "t", { model: MODEL, ask: off.ask })).turns).toBe(1);
    const found = scripted([calls(["finish", { answer: "The item is in stock." }])]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask: found.ask, persist: true });
    expect(done.turns).toBe(1);
  });

  it("sends answers that give up back persistTimes times", async () => {
    const { ask } = scripted([givingUp(), givingUp(), givingUp()]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask, persist: true, persistTimes: 2 });
    expect(done.turns).toBe(3);
    const said = scripted([calls(["finish", { answer: "I did not verify the price." }]), givingUp()]);
    expect((await control(new FakeBrowser(), "t", { model: MODEL, ask: said.ask, persist: true })).turns).toBe(2);
  });

  it("takes an answer that gives up when few browser actions are left", async () => {
    const { ask } = scripted([givingUp()]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask, persist: true, maxBrowserActions: 10 });
    expect(done.turns).toBe(1);
  });
});

describe("control's checkFirst", () => {
  it("answers the first finish with a check against the task, once", async () => {
    const answer = () => calls(["finish", { answer: "Hotel A is cheapest." }]);
    const { ask, asked } = scripted([answer(), answer()]);
    const done = await control(new FakeBrowser(), "t", { model: MODEL, ask, checkFirst: true });
    expect(done).toMatchObject({ answer: "Hotel A is cheapest.", end: "finished", turns: 2 });
    expect(toolTexts(asked[1]!.messages).at(-1)).toContain("check it against the task");
    const off = scripted([answer()]);
    expect((await control(new FakeBrowser(), "t", { model: MODEL, ask: off.ask })).turns).toBe(1);
  });
});

describe("control's compare", () => {
  const A = "https://a.test/offer";
  const B = "https://b.test/offer";
  const C = "https://c.test/offer";
  /** The lines of a long page that names its price once, far down. */
  const offerLines = (price: string): string[] => [
    ...Array.from({ length: 200 }, (_, i) => `${i + 1} text filler ${i + 1}`),
    `text Price ${price}`,
    "201 button Book",
  ];

  /** A browser that compares the pages it is given: each one's page, or why it did not open, and its picture. */
  class Compares extends FakeBrowser {
    compared: [readonly string[], string | undefined][] = [];
    unreachable = new Set<string>();
    async compare(urls: readonly string[], lookFor: string | undefined): Promise<ComparedPage[]> {
      this.compared.push([urls, lookFor]);
      return urls.map((url, i) =>
        this.unreachable.has(url)
          ? { url, error: `${url} did not open: net::ERR_NAME_NOT_RESOLVED` }
          : { url, page: { url, title: `Offer ${i + 1}`, lines: offerLines(`$${100 + i}`) }, shot: JPEG },
      );
    }
  }

  const systemOf = (asked: { messages: unknown[] }[]): string =>
    String((asked[0]!.messages[0] as { content: string }).content);

  it("is offered, after read_page, and the prompt tells when to use it, only when asked", async () => {
    const offered = async (compare: boolean | undefined) => {
      const { ask, asked } = scripted([calls(["finish", { answer: "a" }])]);
      await control(new Compares(), "t", { model: MODEL, ask, compare });
      return { names: asked[0]!.tools.map((tool) => tool.name), system: systemOf(asked) };
    };
    const on = await offered(true);
    expect(on.names.slice(on.names.indexOf("read_page"), on.names.indexOf("read_page") + 2)).toEqual([
      "read_page",
      "compare",
    ]);
    expect(on.system).toContain("Use it when several candidate pages must be checked side by side");
    expect(on.system).toContain("open the chosen page and show its facts there");
    for (const off of [undefined, false]) {
      const { names, system } = await offered(off);
      expect(names).not.toContain("compare");
      expect(system).not.toContain("compare opens");
    }
  });

  it("reads the pages side by side, one browser action a page, each heard as a page of its own with its picture", async () => {
    const browser = new Compares();
    const heard: ToolEvent[] = [];
    const { ask, asked } = scripted([
      calls(["compare", { urls: [A, B, C], look_for: "Price" }]),
      calls(["finish", { answer: "Offer 1" }]),
    ]);
    const done = await control(browser, "t", {
      model: MODEL,
      ask,
      compare: true,
      onTool: (event) => heard.push(event),
    });
    expect(browser.compared).toEqual([[[A, B, C], "Price"]]);
    expect(done.browserActions).toBe(3);
    // Each page is heard as a call of its own, the compare itself is not.
    expect(heard.slice(0, 3).map(({ name, args, ok }) => ({ name, args, ok }))).toEqual(
      [A, B, C].map((url) => ({ name: "compare_page", args: { url, look_for: "Price" }, ok: true })),
    );
    expect(heard.map(({ name }) => name)).not.toContain("compare");
    expect(heard[0]!.image).toEqual({ bytes: JPEG, mimeType: "image/jpeg" });
    // A short text of the page, with the lines around what was looked for.
    expect(heard[0]!.text.startsWith(`Offer 1 (${A})\n198 text filler 198`)).toBe(true);
    expect(heard[0]!.text).toContain("Price $100");
    expect(heard[0]!.text.length).toBeLessThanOrEqual(600);
    const answer = toolTexts(asked[1]!.messages)[0]!;
    expect(answer).toContain(
      `1. Offer 1 (${A})\n"Price" is on 1 of its lines: those and the lines around them come first.\n198 text filler 198`,
    );
    expect(answer).toContain(`3. Offer 3 (${C})`);
    expect(answer).toContain("Price $102");
    expect(answer).toContain("(82 more lines)");
  });

  it("hears a page that did not open as not done, without a picture, and answers what stopped it", async () => {
    const browser = new Compares();
    browser.unreachable.add(B);
    const heard: ToolEvent[] = [];
    const { ask, asked } = scripted([calls(["compare", { urls: [A, B] }]), calls(["finish", { answer: "a" }])]);
    await control(browser, "t", { model: MODEL, ask, compare: true, onTool: (event) => heard.push(event) });
    expect(heard[1]).toEqual({
      name: "compare_page",
      args: { url: B },
      ok: false,
      text: `${B}: ${B} did not open: net::ERR_NAME_NOT_RESOLVED`,
    });
    const answer = toolTexts(asked[1]!.messages)[0]!;
    expect(answer).toContain(`1. Offer 1 (${A})\n1 text filler 1`);
    expect(answer).toContain(`2. ${B}: ${B} did not open`);
  });

  it("refuses too few or too many addresses, one not on the web, and more pages than browser actions are left", async () => {
    const browser = new Compares();
    const { ask, asked } = scripted([
      calls(
        ["compare", { urls: [A] }],
        ["compare", { urls: [A, B, C, A, B, C] }],
        ["compare", { urls: [A, "file:///etc/hosts"] }],
        ["compare", { urls: [A, B, C] }],
      ),
      calls(["finish", { answer: "a" }]),
    ]);
    await control(browser, "t", { model: MODEL, ask, compare: true, maxBrowserActions: 2 });
    expect(browser.compared).toEqual([]);
    const answers = toolTexts(asked[1]!.messages);
    expect(answers.slice(0, 3)).toEqual([
      "error: urls is a list of 2 to 5 web addresses",
      "error: urls is a list of 2 to 5 web addresses",
      "error: urls is a list of 2 to 5 web addresses (http or https)",
    ]);
    expect(answers[3]).toContain("2 are left for its 3 pages");
  });

  it("is no tool when not asked for", async () => {
    const browser = new Compares();
    const { ask, asked } = scripted([calls(["compare", { urls: [A, B] }]), calls(["finish", { answer: "a" }])]);
    await control(browser, "t", { model: MODEL, ask });
    expect(browser.compared).toEqual([]);
    expect(toolTexts(asked[1]!.messages)[0]).toBe("error: there is no tool compare");
  });
});

describe("a compared page's lines", () => {
  const lines = ["a", "b", "c", "d price 1", "e", "f", "g", "h", "i", "j", "k", "l price 2", "m"];

  it("puts the lines around each line that holds the words first, then the others, at most so many", () => {
    expect(comparedLines(lines, "PRICE", 100)).toEqual({
      lines: ["a", "b", "c", "d price 1", "e", "f", "g", "i", "j", "k", "l price 2", "m", "h"],
      found: 2,
    });
    expect(comparedLines(lines, "price", 4).lines).toEqual(["a", "b", "c", "d price 1"]);
  });

  it("gives the first lines without words to look for, or when no line holds them", () => {
    expect(comparedLines(lines, undefined, 3)).toEqual({ lines: ["a", "b", "c"], found: 0 });
    expect(comparedLines(lines, "rent", 3)).toEqual({ lines: ["a", "b", "c"], found: 0 });
  });
});
