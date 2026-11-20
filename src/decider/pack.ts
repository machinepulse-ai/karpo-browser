/**
 * Packing the step's request into the decision model's limits: its budget in tokens, and the most options one
 * question may have. Filled by priority:
 *
 * ① what is always there (the instructions, the task and its values, the run's summary, the fixed options, the
 * newest actions); ② the viewport, whole: its elements with their options, its regions and its text; ③ the parts
 * above and below, whole, else as a summary; ④ the older actions.
 *
 * Nothing of the viewport is left out. When one request does not hold it (more options than the model takes, or more
 * tokens than its budget), its lines are cut, in page order, into groups: each group is asked with the viewport
 * written whole when the budget holds it (its own lines alone when not), offering its own options; then the likeliest
 * over every group, as many as one question takes, are asked again in one request (`packFinalists`) that writes the
 * viewport whole and offers them alone.
 */

import type { Texts } from "../contracts/texts.ts";
import type { PageTree, Part, ReadingSettings } from "../reading/tree.ts";
import type { Marks, Selection, Shown, Written } from "../reading/write.ts";
import { lineText, writePage } from "../reading/write.ts";
import type { Choice, PageSteps, StateParts } from "./request.ts";
import { elementOptions, fixedOptions, request, state, stepQuestion, stepQuestions } from "./request.ts";
import type { DecisionRequest } from "./systemone.ts";
import type { Counter } from "./tokens.ts";

/** A step's request cannot be packed: what is always there and one option take more than the budget. */
export class TooBig extends Error {
  readonly tokens: number;
  readonly budget: number;

  constructor(tokens: number, budget: number) {
    super(`the step's request takes ${tokens} tokens with a single option, past the model's budget of ${budget}`);
    this.tokens = tokens;
    this.budget = budget;
  }
}

/** What a step's request is packed from. */
export interface PackInput {
  tree: PageTree;
  marks: Marks;
  reading: ReadingSettings;
  texts: Texts;
  parts: StateParts;
  /** The recent actions, oldest first, as many as the reading keeps at most. */
  actions: readonly string[];
  steps: PageSteps;
  /**
   * Options not offered in this page state: an element's operation a follow-up found nothing for (FILL with no
   * value that fits, SELECT with no option that does).
   */
  withheld: ReadonlySet<string>;
  /** The budget in tokens. */
  budget: number;
  /** The most options one question may have; 0 for no limit. */
  maxChoices: number;
  counter: Counter;
}

/**
 * A step's requests: one, or the viewport's groups when one request does not hold the viewport, and how many of their
 * likeliest options, over every group, go on to the second request: as many as one question takes besides the fixed
 * ones (all of them when the model has no option limit).
 */
export type Packing = { kind: "one"; packed: Packed } | { kind: "groups"; groups: Packed[]; room: number };

/** Which of a step's requests it is. */
export type Round =
  /** The step's one request. */
  | { kind: "whole" }
  /** One of the viewport's groups, from 1, of how many: its step question alone, offering its own options. */
  | { kind: "group"; n: number; of: number }
  /** The best of that many groups, asked again. */
  | { kind: "finalists"; of: number };

/** A step's request as packed. */
export interface Packed {
  request: DecisionRequest;
  /** The step question's option keys, in order: the elements' first, then the fixed ones. */
  options: string[];
  /** How many of the options are the elements'. */
  elements: number;
  written: Written;
  /** How many recent actions the request gives. */
  actionsGiven: number;
  /** Whether lines of the viewport are not written in it (a group's, or what finalists leave out to fit). */
  cut: boolean;
  /** The request's tokens, counted whole. */
  tokens: number;
  round: Round;
}

/** One piece the budget is spent on. */
interface Piece {
  tokens: number;
  choices: number;
}

/** A text as the request's JSON writes it: quoted and escaped. */
function jsonText(text: string): string {
  return JSON.stringify(text);
}

/** A line of the tree as a piece: its text and, for an element, its options (those offered, when only some are). */
function piece(input: PackInput, line: number, offer: ReadonlySet<string> | undefined): Piece {
  const { tree, counter } = input;
  let tokens = counter(jsonText(lineText(tree, line, input.marks, input.texts, true))) + 1;
  let choices = 0;
  const what = tree.lines[line]!.line;
  if (what.kind === "element") {
    for (const [key, says] of offered(input, what.element)) {
      if (offer && !offer.has(key)) continue;
      tokens += counter(jsonText(key)) + counter(jsonText(says)) + 2;
      choices += 1;
    }
  }
  return { tokens, choices };
}

/** An element's options in this request: its operations, but those withheld in this page state. */
function offered(input: PackInput, element: number): Choice[] {
  return elementOptions(input.tree.elements[element]!, input.reading.optionNames).filter(
    ([key]) => !input.withheld.has(key),
  );
}

/** An action's tokens in the request. */
function actionTokens(input: PackInput, action: string): number {
  return input.counter(jsonText(action)) + 1;
}

/**
 * The lines of a part: the page's parts, whatever the switch on writing them (it changes how they are written, not
 * what the budget and the option limit hold them to).
 */
function inPart(tree: PageTree, part: Part): number[] {
  const lines: number[] = [];
  tree.lines.forEach((line, index) => {
    if (line.part === part) lines.push(index);
  });
  return lines;
}

function isRegion(tree: PageTree, line: number): boolean {
  return tree.lines[line]!.line.kind === "region";
}

/** The viewport's lines but its region headings, which come with the lines under them. */
function viewportLines(tree: PageTree): number[] {
  return inPart(tree, "viewport").filter((line) => !isRegion(tree, line));
}

/** The options one question has room for besides the fixed ones. */
function choiceRoom(input: PackInput, fixed: readonly Choice[]): number {
  return input.maxChoices === 0 ? Number.POSITIVE_INFINITY : Math.max(input.maxChoices - fixed.length, 0);
}

/** How many of the newest actions are always given. */
function newest(input: PackInput): number {
  return Math.min(Math.max(input.reading.recentActionsFirst, 0), input.actions.length);
}

function sum(numbers: readonly number[]): number {
  return numbers.reduce((total, n) => total + n, 0);
}

/** The tokens of what is always there, and of the viewport's region headings. */
function baseTokens(input: PackInput, fixed: readonly Choice[]): number {
  const actions = input.actions.slice(input.actions.length - newest(input));
  const empty = request(state(input.parts, actions, []), stepQuestions(fixed, input.texts));
  const regions = inPart(input.tree, "viewport").filter((line) => isRegion(input.tree, line));
  return input.counter(JSON.stringify(empty)) + sum(regions.map((line) => piece(input, line, undefined).tokens));
}

/** The step's requests; throws `TooBig` when one line of the viewport is past the budget with what is always there. */
export function pack(input: PackInput): Packing {
  const fixed = fixedOptions(input.steps, input.texts);
  const groups = viewportGroups(input, fixed);
  if (groups.length <= 1) return { kind: "one", packed: packWhole(input, fixed, undefined, { kind: "whole" }) };
  const fitted: number[][] = [];
  for (const lines of groups) splitToFit(input, fixed, lines, fitted);
  const of = fitted.length;
  return {
    kind: "groups",
    groups: fitted.map((lines, n) => packGroup(input, fixed, lines, { kind: "group", n: n + 1, of })),
    room: choiceRoom(input, fixed),
  };
}

/**
 * A group's lines as groups whose requests the budget holds, counted whole: the group itself, else its halves, split
 * again as long as they do not fit (the lines were cut by their tokens one by one); throws when one line alone does
 * not.
 */
function splitToFit(input: PackInput, fixed: readonly Choice[], lines: number[], fitted: number[][]): void {
  try {
    packGroup(input, fixed, lines, { kind: "group", n: 1, of: 1 });
    fitted.push(lines);
  } catch (error) {
    if (!(error instanceof TooBig) || lines.length <= 1) throw error;
    const half = Math.floor(lines.length / 2);
    splitToFit(input, fixed, lines.slice(0, half), fitted);
    splitToFit(input, fixed, lines.slice(half), fitted);
  }
}

/**
 * The second request of a step whose viewport was asked in `of` groups: the viewport whole, offering the finalists
 * (likeliest first) and the fixed options alone, with what else the budget holds. When the budget does not hold them
 * all, the least likely go, one at least staying; throws when even one is past it.
 */
export function packFinalists(input: PackInput, finalists: readonly string[], of: number): Packed {
  const fixed = fixedOptions(input.steps, input.texts);
  for (let kept = finalists.length; ; kept -= Math.max(Math.floor(kept / 10), 1)) {
    const packed = packWhole(input, fixed, new Set(finalists.slice(0, kept)), { kind: "finalists", of });
    if (packed.tokens <= input.budget) return packed;
    if (kept <= 1) throw new TooBig(packed.tokens, input.budget);
  }
}

/**
 * The viewport's lines cut, in page order, into groups each of which one request holds with what is always there: at
 * most the options the model takes, at most its budget. One group when one request holds the viewport.
 */
function viewportGroups(input: PackInput, fixed: readonly Choice[]): number[][] {
  const room = choiceRoom(input, fixed);
  const base = baseTokens(input, fixed);
  const groups: number[][] = [[]];
  let tokens = base;
  let choices = 0;
  for (const line of viewportLines(input.tree)) {
    const next = piece(input, line, undefined);
    if (groups.at(-1)!.length > 0 && (choices + next.choices > room || tokens + next.tokens > input.budget)) {
      groups.push([]);
      tokens = base;
      choices = 0;
    }
    tokens += next.tokens;
    choices += next.choices;
    groups.at(-1)!.push(line);
  }
  return groups;
}

/**
 * One group's request, its step question alone offering the group's own options: what is always there and the
 * viewport written whole, so the group's lines are read with the page around them; the group's lines alone (the
 * regions they are under written above them) when the budget does not hold the viewport. Throws when even those are
 * past it (one line no request holds).
 */
function packGroup(input: PackInput, fixed: readonly Choice[], lines: readonly number[], round: Round): Packed {
  const tree = input.tree;
  const own = new Set<string>();
  for (const line of lines) {
    const what = tree.lines[line]!.line;
    if (what.kind === "element") for (const [key] of offered(input, what.element)) own.add(key);
  }
  const whole: Selection = { leftOut: new Set(), above: "nothing", below: "nothing" };
  const around = assemble(input, whole, fixed, own, newest(input), false, round);
  if (around.tokens <= input.budget) return around;
  const mine = new Set(lines);
  const leftOut = new Set(inPart(tree, "viewport").filter((line) => !mine.has(line)));
  const alone = assemble(
    input,
    { leftOut, above: "nothing", below: "nothing" },
    fixed,
    undefined,
    newest(input),
    true,
    round,
  );
  if (alone.tokens <= input.budget) return alone;
  throw new TooBig(alone.tokens, input.budget);
}

/** What the request gives of the tree while it is being fitted. */
interface Fitting {
  leftOut: Set<number>;
  above: Shown;
  below: Shown;
}

/**
 * The step's request with the viewport whole, its elements offering what `offer` holds (all, when none), and the
 * parts off the screen and the older actions as the budget and the option limit leave room.
 */
function packWhole(
  input: PackInput,
  fixed: readonly Choice[],
  offer: ReadonlySet<string> | undefined,
  round: Round,
): Packed {
  const tree = input.tree;
  const room = choiceRoom(input, fixed);
  let spent = baseTokens(input, fixed);
  let choices = 0;
  for (const line of viewportLines(tree)) {
    const next = piece(input, line, offer);
    spent += next.tokens;
    choices += next.choices;
  }
  const first = newest(input);

  // ③ Above and below: whole, else a summary, else nothing.
  const selection: Fitting = { leftOut: new Set(), above: "whole", below: "whole" };
  for (const part of ["above", "below"] as const) {
    const pieces = inPart(tree, part).map((line) => piece(input, line, undefined));
    if (pieces.length === 0) continue;
    const wholeTokens = sum(pieces.map((each) => each.tokens));
    const wholeChoices = sum(pieces.map((each) => each.choices));
    if (spent + wholeTokens <= input.budget && choices + wholeChoices <= room) {
      spent += wholeTokens;
      choices += wholeChoices;
      continue;
    }
    const summary = summaryOf(input, part);
    const summaryTokens = summaryTokensOf(input, summary);
    const summaryChoices = sum(summary.offered.map((element) => offered(input, element).length));
    if (spent + summaryTokens <= input.budget && choices + summaryChoices <= room) {
      spent += summaryTokens;
      choices += summaryChoices;
      selection[part] = "summary";
    } else {
      selection[part] = "nothing";
    }
  }

  // ④ The older actions, newest first.
  const given = { actions: first };
  const most = Math.min(Math.max(input.reading.recentActionsMax, 0), input.actions.length);
  for (const action of input.actions.toReversed().slice(first, Math.max(most, first))) {
    const cost = actionTokens(input, action);
    if (spent + cost > input.budget) break;
    spent += cost;
    given.actions += 1;
  }

  // The pieces were counted one by one: the whole request is counted once more and, when it is over, the least worth
  // keeping goes, piece by piece, until what they free covers the excess; then it is counted again.
  for (;;) {
    const packed = assemble(input, selection, fixed, offer, given.actions, selection.leftOut.size > 0, round);
    if (packed.tokens <= input.budget) return packed;
    let excess = packed.tokens - input.budget;
    let shaved = false;
    while (excess > 0) {
      const freed = shave(input, selection, given, offer);
      if (freed === undefined) break;
      excess = Math.max(excess - Math.max(freed, 1), 0);
      shaved = true;
    }
    if (!shaved) return packed;
  }
}

/**
 * The request as the selection gives it, offering what `offer` holds of the elements written, counted whole. A group
 * asks its step question alone.
 */
function assemble(
  input: PackInput,
  selection: Selection,
  fixed: readonly Choice[],
  offer: ReadonlySet<string> | undefined,
  actionsGiven: number,
  cut: boolean,
  round: Round,
): Packed {
  const written = writePage(input.tree, selection, input.marks, input.reading, input.texts);
  const options = written.offered
    .flatMap((element) => offered(input, element))
    .filter(([key]) => !offer || offer.has(key));
  const elements = options.length;
  options.push(...fixed);
  const actions = input.actions.slice(input.actions.length - actionsGiven);
  const questions = round.kind === "group" ? stepQuestion(options, input.texts) : stepQuestions(options, input.texts);
  const packed = request(state(input.parts, actions, written.lines), questions);
  return {
    request: packed,
    options: options.map(([key]) => key),
    elements,
    written,
    actionsGiven,
    cut,
    tokens: input.counter(JSON.stringify(packed)),
    round,
  };
}

/**
 * Leaves out one more piece, the least worth keeping: an older action, the parts off the screen; and, asking
 * finalists, the viewport's lowest line that offers none of them. What it frees, about; undefined when nothing is left
 * to leave out.
 */
function shave(
  input: PackInput,
  selection: Fitting,
  given: { actions: number },
  offer: ReadonlySet<string> | undefined,
): number | undefined {
  const tree = input.tree;
  if (given.actions > newest(input)) {
    const freed = actionTokens(input, input.actions[input.actions.length - given.actions]!);
    given.actions -= 1;
    return freed;
  }
  for (const part of ["below", "above"] as const) {
    if (selection[part] === "nothing") continue;
    const summary = summaryTokensOf(input, summaryOf(input, part));
    if (selection[part] === "summary") {
      selection[part] = "nothing";
      return summary;
    }
    selection[part] = "summary";
    const whole = sum(inPart(tree, part).map((line) => piece(input, line, undefined).tokens));
    return Math.max(whole - summary, 0);
  }
  if (!offer) return undefined;
  const line = viewportLines(tree).findLast(
    (candidate) => !selection.leftOut.has(candidate) && piece(input, candidate, offer).choices === 0,
  );
  if (line === undefined) return undefined;
  selection.leftOut.add(line);
  return piece(input, line, undefined).tokens;
}

/** A part written as a summary alone. */
function summaryOf(input: PackInput, part: "above" | "below"): Written {
  const selection: Fitting = { leftOut: new Set(inPart(input.tree, "viewport")), above: "nothing", below: "nothing" };
  selection[part] = "summary";
  return writePage(input.tree, selection, input.marks, input.reading, input.texts);
}

/** A summary's tokens. */
function summaryTokensOf(input: PackInput, summary: Written): number {
  return sum(summary.lines.map((line) => input.counter(jsonText(line)) + 1));
}
