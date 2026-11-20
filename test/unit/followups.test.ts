import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Connection } from "../../src/browser/cdp.ts";
import type { Tab } from "../../src/browser/tab.ts";
import { Texts } from "../../src/contracts/texts.ts";
import { fixedOptions } from "../../src/decider/request.ts";
import type { Decider, DecisionRequest, SystemOneQuestion, SystemOneQuestions } from "../../src/decider/systemone.ts";
import { estimate } from "../../src/decider/tokens.ts";
import type { BrowserOptions } from "../../src/index.ts";
import { Browser } from "../../src/index.ts";
import type { Profile } from "../../src/profile.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";
import type { RunResult } from "../../src/run/run.ts";
import { run } from "../../src/run/run.ts";
import type { MadePage, Site } from "./fake.ts";
import { button, dropdown, FakeTab, heading, main, pagesOf, scripted, textbox } from "./fake.ts";

/** The task's values: the first is typed into the email box, the second names the size. */
const VALUES = { email: "ann@example.com", size: "Medium" };
/** What the model answers a box's follow-up (the email, value 1) and the size dropdown's (Medium, its option 1). */
const EMAIL = "1";
const MEDIUM = "1";

/** A form: an email box (2), a button (3), a size dropdown (4) with its options listed under it. */
const FORM: MadePage = {
  url: "https://shop.test/form",
  title: "Sign up",
  body: [main(heading("Sign up"), textbox("Email"), button("Send"), dropdown("Size", ["Small", "Medium", "Large"]))],
};
const FORM_SITE: Site = { start: "form", pages: { form: () => FORM } };

/** A form of four boxes (2 to 5). */
const BOXES = ["First name", "Last name", "Email", "Phone"];
const BOXES_PAGE: MadePage = {
  url: "https://shop.test/details",
  title: "Details",
  body: [main(heading("Your details"), ...BOXES.map(textbox))],
};
const BOXES_SITE: Site = { start: "boxes", pages: { boxes: () => BOXES_PAGE } };

/** A size dropdown longer than one follow-up of the model below holds. */
const SIZES = Array.from({ length: 25 }, (_, at) => `Size ${at + 1}`);
const LONG_PAGE: MadePage = {
  url: "https://shop.test/sizes",
  title: "Sizes",
  body: [main(heading("Pick a size"), textbox("Email"), dropdown("Size", SIZES))],
};
const LONG_SITE: Site = { start: "long", pages: { long: () => LONG_PAGE } };

/** A search box (2), a dropdown with no options yet (3, a State waiting on a Country) and a button (4). */
const SEARCH_PAGE: MadePage = {
  url: "https://shop.test/find",
  title: "Find",
  body: [main(heading("Find a store"), textbox("Search"), dropdown("State", []), button("Go"))],
};
const SEARCH_SITE: Site = { start: "find", pages: { find: () => SEARCH_PAGE } };

/** How a run ended, every request it asked, and its tab. */
interface Ran {
  result: RunResult;
  requests: DecisionRequest[];
  tab: FakeTab;
}

/** A run on a made-up site, its clock held still: the decider is made for its tab. */
async function runOn(
  site: Site,
  decider: (tab: FakeTab) => Decider & { requests: DecisionRequest[] },
  merge: boolean,
  profile: Profile = DEFAULT_PROFILE,
  values: Readonly<Record<string, string>> = VALUES,
): Promise<Ran> {
  const tab = new FakeTab(site);
  const asked = decider(tab);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const options = {
      profile,
      decider: asked,
      screenshot: "none" as const,
      ...(merge ? { mergeFollowups: true } : {}),
    };
    const result = await run(pagesOf(tab), { goal: "Sign up", values }, options);
    return { result, requests: asked.requests, tab };
  } finally {
    vi.useRealTimers();
  }
}

/** The questions of a request, by name. */
function questionsOf(request: DecisionRequest | undefined): SystemOneQuestions {
  return request?.questions ?? {};
}

/** The options of a choice question. */
function choicesOf(question: SystemOneQuestion | undefined): Record<string, string> {
  if (question?.type !== "choice") throw new Error("not a choice question");
  return question.criteria;
}

/** A step on one element until the tab shows it was done, then DONE; follow-ups answered as given. */
function once(step: string, done: (tab: FakeTab) => boolean, followups: Record<string, string>) {
  return (tab: FakeTab) => scripted(() => (done(tab) ? "DONE" : step), followups);
}

/** Whether a box was typed into, or a dropdown set. */
const filled = (tab: FakeTab) => tab.filled.size > 0;
const selected = (tab: FakeTab) => tab.selected.length > 0;

describe("a FILL and a SELECT, their follow-ups asked after the step (the default)", () => {
  let fill: Ran;
  let select: Ran;
  beforeAll(async () => {
    fill = await runOn(FORM_SITE, once("FILL 2", filled, { value: EMAIL }), false);
    select = await runOn(FORM_SITE, once("SELECT 4", selected, { option: MEDIUM }), false);
  });

  it("asks the step's questions alone, then the follow-up in a request of its own", () => {
    expect(fill.requests.map((asked) => Object.keys(questionsOf(asked)))).toEqual([
      ["step", "looping"],
      ["value"],
      ["step", "looping"],
    ]);
    expect(select.requests.map((asked) => Object.keys(questionsOf(asked)))).toEqual([
      ["step", "looping"],
      ["option"],
      ["step", "looping"],
    ]);
    expect([fill.result.status, [...fill.tab.filled.values()]]).toEqual(["done", [VALUES.email]]);
    expect([select.result.status, select.tab.selected.map(([, index, text]) => [index, text])]).toEqual([
      "done",
      [[1, "Medium"]],
    ]);
  });
});

describe("a FILL and a SELECT, their follow-ups asked in the step's request (mergeFollowups)", () => {
  let before: Ran;
  let fill: Ran;
  let select: Ran;
  beforeAll(async () => {
    before = await runOn(FORM_SITE, once("SELECT 4", selected, { option: MEDIUM }), false);
    const merged = { "value 2": EMAIL, "option 4": MEDIUM };
    fill = await runOn(FORM_SITE, once("FILL 2", filled, merged), true);
    select = await runOn(FORM_SITE, once("SELECT 4", selected, merged), true);
  });

  it("asks the box's value and the dropdown's option after the step's questions, each as it is asked alone", () => {
    const [first] = fill.requests;
    expect(Object.keys(questionsOf(first))).toEqual(["step", "looping", "value 2", "option 4"]);
    expect(first!.state).toEqual(before.requests[0]!.state);
    expect(questionsOf(first)["option 4"]).toEqual(questionsOf(before.requests[1]).option);
    const { "value 2": _value, "option 4": _option, ...step } = questionsOf(first);
    expect(step).toEqual(questionsOf(before.requests[0]));
  });

  it("carries out the step on the answers its own request gave, with no second request", () => {
    expect([fill.result.status, fill.requests.length, [...fill.tab.filled.values()]]).toEqual([
      "done",
      2,
      [VALUES.email],
    ]);
    expect(select.tab.selected.map(([, index, text]) => [index, text])).toEqual([[1, "Medium"]]);
    expect([select.result.status, select.requests.length]).toEqual(["done", 2]);
  });

  it("asks the follow-up after the step when the answer leaves it out", async () => {
    const unanswered = await runOn(FORM_SITE, once("FILL 2", filled, { value: EMAIL }), true);
    expect(unanswered.requests.map((asked) => Object.keys(questionsOf(asked)))).toEqual([
      ["step", "looping", "value 2", "option 4"],
      ["value"],
      ["step", "looping", "value 2", "option 4"],
    ]);
    expect([...unanswered.tab.filled.values()]).toEqual([VALUES.email]);
  });
});

describe("a browser's run", () => {
  /** The question names of the requests a run through a browser on the form asks, with the options given. */
  const askedThrough = async (options: BrowserOptions) => {
    const tab = new FakeTab(FORM_SITE);
    const asked = once("FILL 2", filled, { "value 2": EMAIL, value: EMAIL })(tab);
    const made = Browser as unknown as new (connection: Connection, tab: Tab, options: BrowserOptions) => Browser;
    const browser = new made({} as Connection, tab.tab, { screenshot: "none", ...options, decider: asked });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const result = await browser.run({ goal: "Sign up", values: VALUES });
      return [result.status, asked.requests.map((request) => Object.keys(questionsOf(request)))];
    } finally {
      vi.useRealTimers();
    }
  };

  it("asks the follow-ups in the step's own request when the options leave mergeFollowups out", async () => {
    expect(await askedThrough({})).toEqual([
      "done",
      [
        ["step", "looping", "value 2", "option 4"],
        ["step", "looping", "value 2", "option 4"],
      ],
    ]);
    expect(await askedThrough({ mergeFollowups: false })).toEqual([
      "done",
      [["step", "looping"], ["value"], ["step", "looping"]],
    ]);
  });
});

describe("the follow-ups a step's request holds", () => {
  it("are the first three in view; a box past them is asked after the step", async () => {
    const fourth = await runOn(BOXES_SITE, once("FILL 5", filled, { value: EMAIL }), true);
    expect(fourth.requests.map((asked) => Object.keys(questionsOf(asked)))).toEqual([
      ["step", "looping", "value 2", "value 3", "value 4"],
      ["value"],
      ["step", "looping", "value 2", "value 3", "value 4"],
    ]);
  });

  it("leave out a dropdown whose options one follow-up does not hold", async () => {
    const profile = { ...DEFAULT_PROFILE, decider: { ...DEFAULT_PROFILE.decider, maxChoices: 20 } };
    const long = await runOn(LONG_SITE, () => scripted(() => "DONE"), true, profile);
    expect(Object.keys(questionsOf(long.requests[0]))).toEqual(["step", "looping", "value 2"]);
    const held = await runOn(LONG_SITE, () => scripted(() => "DONE"), true);
    expect(Object.keys(questionsOf(held.requests[0]))).toEqual(["step", "looping", "value 2", "option 3"]);
  });

  it("leave out a box when the run has no values, and a dropdown with no options to choose", async () => {
    const none = await runOn(SEARCH_SITE, () => scripted(() => "DONE"), true, DEFAULT_PROFILE, {});
    expect(Object.keys(questionsOf(none.requests[0]))).toEqual(["step", "looping"]);
    const some = await runOn(SEARCH_SITE, () => scripted(() => "DONE"), true);
    expect(Object.keys(questionsOf(some.requests[0]))).toEqual(["step", "looping", "value 2"]);
  });

  it("leave out what the budget does not hold: the request is the step's alone", async () => {
    const alone = await runOn(FORM_SITE, () => scripted(() => "DONE"), false);
    const tokens = estimate(DEFAULT_PROFILE.decider.charsPerToken)(JSON.stringify(alone.requests[0]));
    const contextWindow = tokens + DEFAULT_PROFILE.decider.maxOutputTokens;
    const profile = { ...DEFAULT_PROFILE, decider: { ...DEFAULT_PROFILE.decider, contextWindow } };
    const tight = await runOn(FORM_SITE, () => scripted(() => "DONE"), true, profile);
    expect(JSON.stringify(tight.requests[0])).toBe(JSON.stringify(alone.requests[0]));
  });

  it("are the likeliest first when the viewport was asked in groups", async () => {
    // Room for one box's three options a question, besides the fixed ones (no scroll, nothing to go back to).
    const steps = { scrollDown: false, scrollUp: false, solveCaptcha: true, back: false };
    const fixed = fixedOptions(steps, new Texts(DEFAULT_PROFILE.texts)).length;
    const profile = { ...DEFAULT_PROFILE, decider: { ...DEFAULT_PROFILE.decider, maxChoices: fixed + 3 } };
    const likely: Record<string, number> = { "FILL 4": 0.7, "FILL 2": 0.5, "CLICK 5": 0.4 };
    const ranking = (): Decider & { requests: DecisionRequest[] } => {
      const requests: DecisionRequest[] = [];
      return {
        requests,
        async ask(request) {
          requests.push(request);
          const questions = questionsOf(request);
          if ("looping" in questions) return { answers: { step: { choice: "DONE" }, looping: { noul: 0.01 } } };
          const keys = Object.keys(choicesOf(questions.step));
          const probabilities = Object.fromEntries(keys.map((key) => [key, likely[key] ?? 0.01]));
          return { answers: { step: { choice: keys[0]!, probabilities } } };
        },
      };
    };
    const grouped = await runOn(BOXES_SITE, ranking, true, profile);
    expect(grouped.requests.map((asked) => Object.keys(questionsOf(asked)))).toEqual([
      ["step"],
      ["step"],
      ["step"],
      ["step"],
      ["step", "looping", "value 4", "value 2"],
    ]);
  });
});
