import { describe, expect, it } from "vitest";
import { Texts } from "../../src/contracts/texts.ts";
import { AnswerError, likeliest, readFollowup, readStep, weighed } from "../../src/decider/answer.ts";
import { elementOptions, STEP, stepQuestions } from "../../src/decider/request.ts";
import { imageTokens } from "../../src/decider/screenshot.ts";
import { estimate } from "../../src/decider/tokens.ts";
import type { Element } from "../../src/reading/tree.ts";
import { Keep } from "../../src/reading/tree.ts";

const texts = new Texts({ "decider.step": "step?", "decider.looping": "looping?" });

function element(number: number, role: string, name: string, kind: Element["kind"]): Element {
  return {
    number,
    binding: { session: "", target: "", backendNodeId: number },
    role,
    axRole: role,
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
    kind,
    keep: Keep.Clickable,
    part: "viewport",
    rect: { x: 0, y: 0, w: 100, h: 20 },
  };
}

describe("the request", () => {
  it("a choice question gives its options as criteria, in their order", () => {
    const questions = stepQuestions(
      [
        ["CLICK 5", "button Search"],
        ["DONE", "done"],
      ],
      texts,
    ) as Record<string, { criteria: object }>;
    expect(JSON.stringify(questions[STEP]!.criteria)).toBe('{"CLICK 5":"button Search","DONE":"done"}');
    expect(Object.keys(questions)).toEqual(["step", "looping"]);
  });

  it("a native dropdown is set, never clicked; a box is filled, clicked or entered", () => {
    const dropdown = element(16, "select", "Time selector", { kind: "select", options: [] });
    expect(elementOptions(dropdown, true)).toEqual([["SELECT 16", "select Time selector"]]);
    const box = element(9, "textbox", "Email", { kind: "input", readonly: false });
    expect(elementOptions(box, false).map(([key]) => key)).toEqual(["FILL 9", "CLICK 9", "PRESS_ENTER 9"]);
    expect(elementOptions({ ...box, disabled: true }, true)).toEqual([]);
  });

  it("counts tokens by characters and an image by its tiles", () => {
    expect(estimate(3)("abcd")).toBe(2);
    expect(estimate(0)("abcdef")).toBe(2);
    expect(imageTokens(768, 480)).toBe(362);
    expect(imageTokens(768, 431)).toBe(24 * 14 + 2);
  });
});

describe("the answer", () => {
  const options = ["CLICK 5", "CLICK 6", "CLICK 7"];

  it("the step is the likeliest offered option, a tie going to the one offered first", () => {
    const answer = {
      answers: {
        step: { choice: "WAIT", probabilities: { "CLICK 5": 0.4, "CLICK 6": 0.4, WAIT: 0.2 } },
        looping: { noul: 0.1 },
      },
    };
    const step = readStep(answer, [...options, "WAIT"]);
    expect([step.key, step.looping, step.ending]).toEqual(["CLICK 5", 0.1, undefined]);
    expect(readStep({ step: { choice: "BLOCKED", note: " denied " } }, ["BLOCKED"])).toMatchObject({
      key: "BLOCKED",
      ending: "BLOCKED",
      note: "denied",
    });
    expect(() => readStep({ step: { choice: "CLICK 9" } }, options)).toThrow(AnswerError);
  });

  it("a follow-up answers an option, or nothing for NONE", () => {
    expect(readFollowup({ answers: { value: { choice: "2" } } }, "value", ["1", "2", "NONE"])).toBe("2");
    expect(readFollowup({ answers: { value: { choice: "NONE" } } }, "value", ["1", "NONE"])).toBeUndefined();
  });

  it("a group's options are weighed only when the model weighs them all", () => {
    const all = {
      answers: {
        step: { choice: "CLICK 6", probabilities: { "CLICK 5": 0.1, "CLICK 6": 0.6, "CLICK 7": 0.0, WAIT: 0.3 } },
      },
    };
    expect(weighed(all, STEP, options).map(([, probability]) => probability)).toEqual([0.1, 0.6, 0.0]);
    expect(() => weighed({ answers: { step: { choice: "WAIT" } } }, STEP, options)).toThrow(AnswerError);
    expect(() =>
      weighed({ answers: { step: { choice: "CLICK 5", probabilities: { "CLICK 5": 0.9 } } } }, STEP, options),
    ).toThrow(AnswerError);
  });

  it("the likeliest are taken over every group, one free to take every place", () => {
    const groups = [
      [
        ["CLICK 5", 0.5],
        ["CLICK 6", 0.3],
      ] as const,
      [
        ["CLICK 7", 0.3],
        ["CLICK 8", 0.1],
      ] as const,
    ];
    expect(likeliest(groups, 3)).toEqual(["CLICK 5", "CLICK 6", "CLICK 7"]);
  });
});
