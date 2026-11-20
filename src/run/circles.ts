/**
 * Whether a run is going in circles, as its steps show it: the page states it comes back to with nothing new since it
 * was last in them, and a round of steps its latest steps repeat with nothing new to show for them. What a run
 * working through a list does (a list, an item, the list again, the next item) is no circle: each item is new to it.
 * What changes on a page by itself (a carousel turning, a timer ticking) is no new state, nor new words: a page's
 * state here is its steady one (`Reading.steady`), and its words leave those lines out.
 *
 * Kept apart from the history the decision model reads: nothing here goes into a request.
 */

import { PAGE_NUMBER, readKey } from "../contracts/actions.ts";
import type { PageTree } from "../reading/tree.ts";
import { elementOf } from "../reading/tree.ts";
import { elementWords, SHORT_NAME_CHARS } from "../reading/write.ts";
import type { Taken } from "./history.ts";
import { isScroll, label, lineWords } from "./history.ts";
import type { Reading } from "./page.ts";

/**
 * The rounds of steps a run's latest steps may repeat as it goes in circles: of 2 to 4 steps, taken over the latest 6
 * steps at least and twice at least (a round of 4 over the latest 8).
 */
const SHORTEST_ROUND = 2;
const LONGEST_ROUND = 4;
const LEAST_ROUND_STEPS = 6;
const LEAST_ROUNDS = 2;

/** A step as rounds are found by: its operation, and the element it is on by its role and name (none for a step on
 * the page as a whole or its scroll). */
interface Move {
  operation: string;
  words: string | undefined;
}

/** A step the run took, as its circles are found by. */
interface Step {
  move: Move;
  /** What it did to what (`label`): a step taken again has the same. */
  label: string;
  /** It reached the page. */
  done: boolean;
  /** The page state it was taken in, and whether the state changed after it. */
  before: string;
  changed: boolean;
  /** The page read after it showed a word new to the run. */
  fresh: boolean;
}

/** A round of steps the latest steps repeat: how many steps it has, and how many times they were taken in a row. */
export interface Round {
  steps: number;
  rounds: number;
}

export class Circles {
  private readonly steps: Step[] = [];
  /** Every word the run read on its pages (`wordsOf`). */
  private readonly words = new Set<string>();
  /** How many readings brought something new to the run: a page state, or a word, it had not read before. */
  private progress = 0;
  /** The run's progress when it was last in each page state it read. */
  private readonly lastIn = new Map<string, number>();
  /** The times a step brought the page back to each state with nothing new since the run was last in it. */
  private readonly arrived = new Map<string, number>();

  /** A reading of the page, after the step taken last. */
  read(reading: Reading): void {
    let fresh = false;
    for (const words of wordsOf(reading.tree)) {
      if (this.words.has(words)) continue;
      this.words.add(words);
      fresh = true;
    }
    const last = this.steps.at(-1);
    if (last && fresh) last.fresh = true;
    if (fresh || !this.lastIn.has(reading.steady)) this.progress += 1;
    this.lastIn.set(reading.steady, this.progress);
  }

  /** A step taken on the page read as `before`, the page then read as `after`. */
  took(taken: Taken, before: Reading, after: Reading): void {
    const step: Step = {
      move: { operation: taken.operation, words: taken.target?.words },
      label: label(taken),
      done: taken.done,
      before: before.steady,
      changed: before.steady !== after.steady,
      fresh: false,
    };
    if (this.cameBack(step, after.steady)) this.arrived.set(after.steady, this.arrivals(after) + 1);
    this.steps.push(step);
  }

  /** How many times a step brought the page back to the state it is read in, with nothing new since (`cameBack`). */
  arrivals(reading: Reading): number {
    return this.arrived.get(reading.steady) ?? 0;
  }

  /**
   * The round of steps the run's latest steps repeat, the step `key` chosen now on the page `tree` the last of them:
   * the shortest round, not one step alone, that the latest steps repeat over `LEAST_ROUND_STEPS` steps and
   * `LEAST_ROUNDS` rounds at least, each step the same operation on an element of the same role and name as the step a
   * round before it. None when a page read after a step past the first of those rounds showed a word new to the run
   * (a list's next item, more results, a later month: the run is getting on).
   */
  round(tree: PageTree, key: string): Round | undefined {
    const moves = [...this.steps, { move: chosen(tree, key), fresh: false }];
    for (let steps = SHORTEST_ROUND; steps <= LONGEST_ROUND; steps += 1) {
      const span = Math.max(LEAST_ROUND_STEPS, steps * LEAST_ROUNDS);
      if (moves.length < span) continue;
      const latest = moves.slice(-span);
      const alone = latest.slice(1, steps).every(({ move }) => same(move, latest[0]!.move));
      const repeated = latest.every(({ move }, at) => at < steps || same(move, latest[at - steps]!.move));
      const fresh = latest.slice(steps).some((step) => step.fresh);
      if (!alone && repeated && !fresh) return { steps, rounds: span / steps };
    }
    return undefined;
  }

  /**
   * Whether `step` brought the page back to `state` with nothing new since the run was last in it, as an arrival
   * toward the looping stop counts: a step that reached the page and did not scroll it (a scroll that moved the page
   * is no coming back to it). One that changed the page's state counts unless a reading since the run was last in
   * `state` brought a page state or a word new to the run (a list, an item, the list again is no circle); one that
   * changed nothing, only when it repeats a step taken since the page came to `state`, the step that brought it there
   * among them (a step tried for the first time is no circle; steps tried in turn on a page that never changes are).
   */
  private cameBack(step: Step, state: string): boolean {
    if (!step.done || isScroll(step.move.operation)) return false;
    if (step.changed) {
      const then = this.lastIn.get(state);
      return then === undefined || then === this.progress;
    }
    // Newest first, down to the step that brought the page to the state.
    for (let at = this.steps.length - 1; at >= 0; at -= 1) {
      const earlier = this.steps[at]!;
      if (earlier.done && earlier.label === step.label) return true;
      if (earlier.before !== state) return false;
    }
    return false;
  }
}

/** The step an option key chooses on the page `tree`, as rounds are found by. */
function chosen(tree: PageTree, key: string): Move {
  const { operation, number } = readKey(key);
  const element = number === undefined || number === PAGE_NUMBER ? undefined : elementOf(tree, number);
  return { operation, words: element ? elementWords(element, SHORT_NAME_CHARS) : undefined };
}

function same(a: Move, b: Move): boolean {
  return a.operation === b.operation && a.words === b.words;
}

/**
 * The words of a page's lines, each line's its own: an element's role and name, a region's, a heading's or a text's;
 * none of the lines of what changes on the page by itself.
 */
function wordsOf(tree: PageTree): string[] {
  return tree.lines.flatMap(({ line }, at) => {
    if (tree.changing.has(at)) return [];
    const element = line.kind === "element" ? tree.elements[line.element] : undefined;
    const words = element ? elementWords(element, SHORT_NAME_CHARS) : lineWords(line);
    return words === undefined ? [] : [words];
  });
}
