/**
 * The decision request: the state the questions are about, and the questions.
 *
 * ```json
 * {"state": {"task": {"goal": "…"}, "values": [{"n": 1, "name": "restaurant", "text": "…"}, {"n": 2, "name": "password", "secret": true}],
 *            "run": {…}, "recent_actions": "CLICK 5 button …\n  5 [expanded: false → true]",
 *            "page": {"url": "…", "title": "…", "elements": ["viewport (scrolled 0/2100px):", "  5 button Search", …]}},
 *  "questions": {"step": {"type": "choice", "instructions": "…", "criteria": {"CLICK 5": "button Search", …, "DONE": "…"}},
 *                "looping": {"type": "noul", "instructions": "…"}}}
 * ```
 *
 * A FILL or SELECT step is asked again about its element alone (`value`, `option`), with the same state; or, asked in
 * advance, in the step's own request after its questions (`withFollowups`: `"value 7"`, `"option 9"`). The order of
 * the fields is part of the request: the model reads them in it.
 */

import * as actions from "../contracts/actions.ts";
import { ENDINGS } from "../contracts/endings.ts";
import type { Texts } from "../contracts/texts.ts";
import {
  DECIDER_LOOPING,
  DECIDER_OPTION,
  DECIDER_STEP,
  DECIDER_VALUE,
  endingCode,
  OPTION_PAGE_SCROLL_DOWN,
  OPTION_PAGE_SCROLL_UP,
  optionCode,
} from "../contracts/texts.ts";
import type { Element, PageTree, SelectOption } from "../reading/tree.ts";
import { acts, contextOf } from "../reading/tree.ts";
import { elementLine, elementWords, SHORT_NAME_CHARS } from "../reading/write.ts";
import { cut } from "../text.ts";
import type { ChoiceQuestion, DecisionRequest, SystemOneQuestions, SystemOneState } from "./systemone.ts";

/** The questions' names, as the answers come back under them. */
export const STEP = "step";
export const LOOPING = "looping";
export const VALUE = "value";
export const OPTION = "option";
/** The question types the decision model answers. */
const CHOICE = "choice" as const;
const NOUL = "noul" as const;
/** A follow-up's answer for "none of these". */
export const NONE = "NONE";
/** What separates the regions a follow-up's element is under, and the texts near it. */
const PATH_SEPARATOR = " › ";
const NEARBY_SEPARATOR = " · ";
/** The longest text near an element a follow-up gives. */
const NEARBY_MAX_CHARS = 400;

/**
 * One value of the task the model may fill a box with: its number, its name, its text (none for a secret, which is
 * typed without the model seeing it).
 */
export interface TaskValue {
  n: number;
  name: string;
  text: string | undefined;
}

/** What the state holds besides the page's lines. */
export interface StateParts {
  goal: string;
  values: readonly TaskValue[];
  /** The run's summary, when the reading gives it. */
  run: unknown;
  url: string;
  title: string;
}

/** An option of a choice question: the answer it is, and what it says. */
export type Choice = readonly [key: string, says: string];

/** The state: the task, its values, the run, the recent actions (one string, oldest first) and the page. */
export function state(
  parts: StateParts,
  recentActions: readonly string[],
  elements: readonly string[],
): SystemOneState {
  return {
    task: { goal: parts.goal },
    values: parts.values.map(({ n, name, text }) =>
      text === undefined ? { n, name, secret: true as const } : { n, name, text },
    ),
    ...(parts.run === undefined ? {} : { run: parts.run }),
    ...(recentActions.length === 0 ? {} : { recent_actions: recentActions.join("\n") }),
    page: { url: parts.url, title: parts.title, elements },
  };
}

/** The steps on the page as a whole the model is offered now. */
export interface PageSteps {
  scrollDown: boolean;
  scrollUp: boolean;
  /** Off once solving found nothing to solve in this page state: SOLVE_CAPTCHA is not offered again. */
  solveCaptcha: boolean;
  /** There is a page to go back to: an earlier one in this tab, or the page that opened this tab. */
  back: boolean;
}

/** The operations an element is offered, by its kind. */
function operationsOf(element: Element): string[] {
  switch (element.kind.kind) {
    case "input":
      return element.kind.readonly
        ? [actions.CLICK, actions.PRESS_ENTER]
        : [actions.FILL, actions.CLICK, actions.PRESS_ENTER];
    // Set, never clicked open: the browser draws a native dropdown's open list outside the page.
    case "select":
      return [actions.SELECT];
    case "click":
      return [actions.CLICK];
    case "scroll":
      return [...(element.kind.down ? [actions.SCROLL_DOWN] : []), ...(element.kind.up ? [actions.SCROLL_UP] : [])];
    case "shown":
      return [];
  }
}

/** An element's options: their keys, and what each says when the reading names elements. */
export function elementOptions(element: Element, named: boolean): Choice[] {
  if (!acts(element)) return [];
  const says = named ? elementWords(element, SHORT_NAME_CHARS) : "";
  return operationsOf(element).map((operation) => [actions.optionKey(operation, element.number), says]);
}

/**
 * The options that do not depend on the page's elements, in their order: the page's scrolls, the steps on the page
 * as a whole, the endings, DONE.
 */
export function fixedOptions(steps: PageSteps, texts: Texts): Choice[] {
  const page = actions.PAGE_NUMBER;
  const offered: Record<string, boolean> = { [actions.SOLVE_CAPTCHA]: steps.solveCaptcha, [actions.BACK]: steps.back };
  return [
    ...(steps.scrollDown
      ? [[actions.optionKey(actions.SCROLL_DOWN, page), texts.get(OPTION_PAGE_SCROLL_DOWN)] as const]
      : []),
    ...(steps.scrollUp
      ? [[actions.optionKey(actions.SCROLL_UP, page), texts.get(OPTION_PAGE_SCROLL_UP)] as const]
      : []),
    ...actions.PAGE_STEPS.filter((step) => offered[step] ?? true).map(
      (step) => [step, texts.get(optionCode(step))] as const,
    ),
    ...ENDINGS.map((ending) => [ending, texts.get(endingCode(ending))] as const),
    [actions.DONE, texts.get(optionCode(actions.DONE))],
  ];
}

function stepChoice(options: readonly Choice[], texts: Texts): ChoiceQuestion {
  return { type: CHOICE, instructions: texts.get(DECIDER_STEP), criteria: Object.fromEntries(options) };
}

/** The step question alone, as a group of a step's viewport asks it. */
export function stepQuestion(options: readonly Choice[], texts: Texts): SystemOneQuestions {
  return { [STEP]: stepChoice(options, texts) };
}

/** The step question and the looping question. */
export function stepQuestions(options: readonly Choice[], texts: Texts): SystemOneQuestions {
  return { [STEP]: stepChoice(options, texts), [LOOPING]: { type: NOUL, instructions: texts.get(DECIDER_LOOPING) } };
}

/** What a follow-up tells of its element: its whole line, the regions and heading it is under, the text near it. */
export interface ElementContext {
  line: string;
  path: readonly string[];
  nearby: readonly string[];
}

/** What a follow-up tells of an element of a page: its line, written whole, where it is, and the text near it. */
export function elementContext(tree: PageTree, element: Element, texts: Texts): ElementContext {
  const index = tree.elements.findIndex((candidate) => candidate.number === element.number);
  const { path, nearby } = index < 0 ? { path: [], nearby: [] } : contextOf(tree, index);
  return { line: elementLine(element, texts, Number.POSITIVE_INFINITY), path, nearby };
}

function places(context: ElementContext): Record<string, string> {
  return {
    element: context.line,
    path: context.path.join(PATH_SEPARATOR),
    nearby: cut(context.nearby.join(NEARBY_SEPARATOR), NEARBY_MAX_CHARS),
  };
}

/** The FILL follow-up: which of the task's values goes into this box, or NONE. */
export function valueQuestion(context: ElementContext, values: readonly TaskValue[], texts: Texts): SystemOneQuestions {
  const criteria = Object.fromEntries([...values.map((value) => [String(value.n), ""]), [NONE, ""]]);
  return { [VALUE]: { type: CHOICE, instructions: texts.fill(DECIDER_VALUE, places(context)), criteria } };
}

/**
 * The SELECT follow-up: which of the dropdown's options, by live index, or NONE; at most `maxChoices` options with
 * NONE (the first ones of a longer dropdown).
 */
export function optionQuestion(
  context: ElementContext,
  options: readonly SelectOption[],
  maxChoices: number,
  texts: Texts,
): SystemOneQuestions {
  const room = maxChoices === 0 ? options.length : Math.max(maxChoices - 1, 0);
  const listed = options.filter((option) => !option.disabled).slice(0, room);
  const criteria = Object.fromEntries([...listed.map((option) => [String(option.index), option.text]), [NONE, ""]]);
  return { [OPTION]: { type: CHOICE, instructions: texts.fill(DECIDER_OPTION, places(context)), criteria } };
}

/** A follow-up's name in the step's own request: its question's name and its element's number ("value 7"). */
export function followupName(question: string, element: number): string {
  return `${question} ${element}`;
}

/**
 * The step's questions with follow-ups asked in the same request after them: each follow-up's question (`{value: …}`
 * or `{option: …}`) as it is asked alone, under its name there (`followupName`).
 */
export function withFollowups(
  questions: SystemOneQuestions,
  followups: readonly { element: number; question: SystemOneQuestions }[],
): SystemOneQuestions {
  const merged: SystemOneQuestions = { ...questions };
  for (const { element, question } of followups) {
    for (const [name, asked] of Object.entries(question)) merged[followupName(name, element)] = asked;
  }
  return merged;
}

/** The request: the state and the questions. */
export function request(stateOfIt: SystemOneState, questions: SystemOneQuestions): DecisionRequest {
  return { state: stateOfIt, questions };
}
