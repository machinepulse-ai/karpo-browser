/**
 * What the run did, as the decision model reads it: each action with what changed on the page after it, written as
 * differences of the page tree under the action's line; the run's summary; the page states it came back to, and what
 * was tried in them.
 *
 * ```text
 * CLICK 5 button Destination Area, station, line or restaurant
 *   5 [expanded: false → true]
 *   + dialog Destination
 *   + 61 textbox Destination (14 appeared in all)
 * FILL 61 1
 *   61 [value: "" → Yakiniku Ushigoro Ginza]
 * CLICK 70 option Yakiniku Ushigoro Ginza
 *   page → www.tablecheck.com/en/ushigoro-ginza
 * ```
 *
 * An element still on the page goes by its number in the page as it is now; one gone by its role and name.
 */

import { PAGE_NUMBER, SCROLL_DOWN, SCROLL_UP } from "../contracts/actions.ts";
import type { Texts } from "../contracts/texts.ts";
import { EFFECT_MORE_APPEARED, EFFECT_MORE_REMOVED, EFFECT_NO_CHANGE, PAGE_TRIED } from "../contracts/texts.ts";
import { shortUrl } from "../reading/state.ts";
import type { Binding, Element, Line, PageTree } from "../reading/tree.ts";
import { Keep } from "../reading/tree.ts";
import type { Marks } from "../reading/write.ts";
import { elementWords, SHORT_NAME_CHARS } from "../reading/write.ts";
import { cut } from "../text.ts";
import type { Reading } from "./page.ts";

/** The most lines under one action. */
const MAX_CHANGE_LINES = 5;
/** The longest text a change line gives. */
const CHANGE_TEXT_CHARS = 80;
/** The states a change line follows, as the tree writes them. */
const STATES = ["expanded", "selected", "checked", "disabled", "required"];
/** The state a box's or a dropdown's value is followed as. */
const VALUE_STATE = "value";
/** How a flag the tree writes without a value reads in a change line. */
const SET = "true";
const UNSET = "false";
/** How an empty value reads in a change line. */
const EMPTY_VALUE = '""';
/** What a secret box's characters are written as. */
const SECRET_CHARACTER = "•";
/** The marks of change lines. */
const ADDED_MARK = "+";
const REMOVED_MARK = "-";
const NOTE_MARK = "→";
/** Between a FILL's box and the value it typed, in a run's result. */
const VALUE_MARK = "←";
/** The page as a whole, in a run's result (the decision model reads it as its number). */
const PAGE_WORD = "page";
const PAGE_MARK = "page →";
/** How the tree writes headings and texts, which change lines name the same way. */
const HEADING = "heading";
const TEXT = "text";

function bindingKey(binding: Binding): string {
  return `${binding.backendNodeId} ${binding.target} ${binding.session}`;
}

/** An element as an action named it: its node, and its role and name then. */
export interface Named {
  binding: Binding;
  words: string;
}

function named(element: Element): Named {
  return { binding: element.binding, words: elementWords(element, SHORT_NAME_CHARS) };
}

/** The number an element named before has on the page now, when the page has it. */
function numberOf(element: Named, tree: PageTree | undefined): number | undefined {
  const key = bindingKey(element.binding);
  return tree?.elements.find((candidate) => bindingKey(candidate.binding) === key)?.number;
}

/** "61 textbox Destination" while the page has it, else "textbox Destination". */
function lineOf(element: Named, tree: PageTree | undefined): string {
  const number = numberOf(element, tree);
  return number === undefined ? element.words : `${number} ${element.words}`;
}

/** "61" while the page has it, else its role and name. */
function referenceOf(element: Named, tree: PageTree | undefined): string {
  return numberOf(element, tree)?.toString() ?? element.words;
}

/** An action as it was carried out, before the page is read again. */
export interface Taken {
  operation: string;
  /** The element it was on; none for a step on the page as a whole and for a scroll of the page. */
  target: Named | undefined;
  /** FILL's value number, SELECT's option text. */
  argument: string | undefined;
  /** FILL's value by the name the caller gave it: how a run's result names it, where the model reads its number. */
  value: string | undefined;
  /** What the run says of it: why it was not done, or what came of it. */
  note: string | undefined;
  /** Whether it reached the page; one that did not shows only its note. */
  done: boolean;
}

/** An action on the page as a whole. */
export function takenOnPage(operation: string): Taken {
  return { operation, target: undefined, argument: undefined, value: undefined, note: undefined, done: true };
}

/** An action on an element. */
export function takenOn(operation: string, element: Element): Taken {
  return { ...takenOnPage(operation), target: named(element) };
}

/** One line under an action. */
type Change =
  /** What the run says. */
  | { kind: "note"; note: string }
  /** The page went to another address. */
  | { kind: "page"; url: string }
  /** The page scrolled: from where to where of how far it goes. */
  | { kind: "pageScrolled"; from: number; to: number; max: number }
  /** A scroll area scrolled. */
  | { kind: "scrolled"; element: Named }
  /** A state or the value of an element on the page before and after. */
  | { kind: "state"; element: Named; state: string; from: string; to: string }
  /** An element, or a region, heading or text, that appeared; `more` notes how many appeared in all. */
  | { kind: "added"; element: Named | undefined; words: string; more: number | undefined }
  /** What went away. */
  | { kind: "removed"; words: string; more: number | undefined };

function changeLine(change: Change, tree: PageTree | undefined, texts: Texts): string {
  switch (change.kind) {
    case "note":
      return `${NOTE_MARK} ${change.note}`;
    case "page":
      return `${PAGE_MARK} ${change.url}`;
    case "pageScrolled":
      return `${pageWord(tree)} [scrolled: ${change.from} → ${change.to}/${change.max}px]`;
    case "scrolled":
      return `${referenceOf(change.element, tree)} [scrolled]`;
    case "state":
      return `${referenceOf(change.element, tree)} [${change.state}: ${change.from} → ${change.to}]`;
    case "added": {
      const what = change.element ? lineOf(change.element, tree) : change.words;
      return withMore(`${ADDED_MARK} ${what}`, change.more, EFFECT_MORE_APPEARED, texts);
    }
    case "removed":
      return withMore(`${REMOVED_MARK} ${change.words}`, change.more, EFFECT_MORE_REMOVED, texts);
  }
}

function withMore(line: string, more: number | undefined, code: string, texts: Texts): string {
  return more === undefined ? line : `${line} ${texts.fill(code, { n: String(more) })}`;
}

/** An action and what came of it. */
interface Action {
  taken: Taken;
  changes: Change[];
}

/** "CLICK 5 button Search", "FILL 61 1", "SCROLL_DOWN 1", "WAIT". */
function header(action: Action, tree: PageTree | undefined): string {
  const { operation, target, argument, value } = action.taken;
  if (!target) return isScroll(operation) ? `${operation} ${pageWord(tree)}` : operation;
  if (argument === undefined) return `${operation} ${lineOf(target, tree)}`;
  // A run's result (no page tree): the value as the caller named it, never the decision model's number.
  if (value !== undefined && !tree) return `${operation} ${target.words} ${VALUE_MARK} ${value}`;
  return `${operation} ${referenceOf(target, tree)} ${argument}`;
}

function block(action: Action, tree: PageTree | undefined, texts: Texts): string {
  return [header(action, tree), ...action.changes.map((change) => `  ${changeLine(change, tree, texts)}`)].join("\n");
}

/** An action as the run's summary counts it: what it did to what, without numbers. */
export function label(taken: Taken): string {
  const { operation, target, argument } = taken;
  return [operation, target?.words, argument].filter((part) => part !== undefined).join(" ");
}

/** The page as a whole: the decision model's number for it, or (in a run's result, with no page tree) the word. */
function pageWord(tree: PageTree | undefined): string {
  return tree ? String(PAGE_NUMBER) : PAGE_WORD;
}

export function isScroll(operation: string): boolean {
  return operation === SCROLL_DOWN || operation === SCROLL_UP;
}

/** A run's latest actions, oldest first. */
export class Recent {
  private readonly actions: readonly Action[];

  constructor(actions: readonly Action[]) {
    this.actions = actions;
  }

  /** Each action and what it changed, as `tree` numbers their elements (by their words alone with none). */
  lines(tree: PageTree | undefined, texts: Texts): string[] {
    return this.actions.map((action) => block(action, tree, texts));
  }
}

function add(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The run's history. */
export class History {
  private readonly actions: Action[] = [];
  /** Decisions taken. */
  decisions = 0;
  /** Readings of each page state. */
  private readonly seen = new Map<string, number>();
  /** What was tried on an element (by its role and name) in a page state: how often, and what came of it last. */
  private readonly tried = new Map<string, { times: number; result: string }>();
  /** The addresses visited, in order, with how often the run came to each. */
  private readonly pages = new Map<string, number>();
  private lastPage: string | undefined;
  private unchangedInARow = 0;
  /** How often each action was taken in the run, and how often it changed the page. */
  private readonly counts = new Map<string, { times: number; changedPage: number }>();

  /** A new reading of the page. */
  read(reading: Reading): void {
    add(this.seen, reading.state);
    const page = shortUrl(reading.tree.url);
    if (this.lastPage !== page) {
      add(this.pages, page);
      this.lastPage = page;
    }
  }

  /** What came of an action, from the readings before and after it. */
  took(taken: Taken, before: Reading, after: Reading, texts: Texts): void {
    const changes: Change[] = taken.note === undefined ? [] : [{ kind: "note", note: taken.note }];
    if (taken.done) {
      changes.push(...changesBetween(taken, before.tree, after.tree));
      if (changes.length === 0) changes.push({ kind: "note", note: texts.get(EFFECT_NO_CHANGE) });
    }
    const changed = before.state !== after.state;
    this.unchangedInARow = changed ? 0 : this.unchangedInARow + 1;
    const action = { taken, changes };
    if (taken.target) {
      const key = triedKey(before.state, taken.target.words);
      const result = changes[0] ? changeLine(changes[0], undefined, texts) : "";
      this.tried.set(key, { times: (this.tried.get(key)?.times ?? 0) + 1, result: cut(result, CHANGE_TEXT_CHARS) });
    }
    const name = label(taken);
    const count = this.counts.get(name) ?? { times: 0, changedPage: 0 };
    this.counts.set(name, { times: count.times + 1, changedPage: count.changedPage + (changed ? 1 : 0) });
    this.actions.push(action);
  }

  /** The actions taken, as the result lists them: what each did to what. */
  labels(): string[] {
    return this.actions.map((action) => label(action.taken));
  }

  /** The marks of elements tried in this page state before, when the page was in it before. */
  marks(reading: Reading, texts: Texts): Marks {
    const marks = new Map<number, string>();
    if ((this.seen.get(reading.state) ?? 0) < 2) return marks;
    reading.tree.elements.forEach((element, index) => {
      const tried = this.tried.get(triedKey(reading.state, elementWords(element, SHORT_NAME_CHARS)));
      if (tried) marks.set(index, texts.fill(PAGE_TRIED, { n: String(tried.times), result: tried.result }));
    });
    return marks;
  }

  /** The latest actions, oldest first, at most `max`, as the page now numbers their elements. */
  recent(tree: PageTree, max: number, texts: Texts): string[] {
    return this.latest(max).lines(tree, texts);
  }

  /** The latest actions, oldest first, at most `max`. */
  latest(max: number): Recent {
    return new Recent(this.actions.slice(Math.max(this.actions.length - max, 0)));
  }

  /** The run's summary (`state.run`). */
  summary(reading: Reading, seconds: number): object {
    return {
      decisions: this.decisions,
      seconds: Math.max(Math.round(seconds), 0),
      page_state_seen: this.seen.get(reading.state) ?? 0,
      actions_without_change_in_a_row: this.unchangedInARow,
      pages: [...this.pages].map(([url, visits]) => ({ url, visits })),
      actions: [...this.counts].map(([action, count]) => ({
        action,
        times: count.times,
        changed_page: count.changedPage,
      })),
    };
  }
}

function triedKey(state: string, words: string): string {
  return `${state} ${words}`;
}

/**
 * What an action that reached the page changed: another address; else where the page or a scroll area scrolled, then
 * the states and values of elements on the page before and after (the acted one's first), what appeared and what
 * went away. At most `MAX_CHANGE_LINES`. Elements are paired by what they are, so a page that draws the same elements
 * anew has not changed them.
 */
function changesBetween(taken: Taken, before: PageTree, after: PageTree): Change[] {
  if (shortUrl(before.url) !== shortUrl(after.url)) return [{ kind: "page", url: shortUrl(after.url) }];
  const changes: Change[] = [];
  if (isScroll(taken.operation)) {
    if (taken.target) changes.push({ kind: "scrolled", element: taken.target });
    else if (before.scroll.top !== after.scroll.top) {
      changes.push({ kind: "pageScrolled", from: before.scroll.top, to: after.scroll.top, max: after.scroll.maxTop });
    }
  }
  const pairs = paired(before, after);
  const acted = taken.target ? bindingKey(taken.target.binding) : undefined;
  const states: Change[] = [];
  after.elements.forEach((element, index) => {
    const was = before.elements[pairs.get(index) ?? -1];
    if (!was) return;
    for (const [state, from, to] of stateChanges(was, element)) {
      const change: Change = { kind: "state", element: named(element), state, from, to };
      if (acted === bindingKey(was.binding)) states.unshift(change);
      else states.push(change);
    }
  });
  changes.push(...states);
  const added = appeared(before, after, new Set(pairs.keys()));
  const removed = appeared(after, before, new Set(pairs.values()));
  const shownAdded = Math.min(added.length, Math.max(MAX_CHANGE_LINES - changes.length, 0));
  added.slice(0, shownAdded).forEach(({ element, words }, index) => {
    const more = index + 1 === shownAdded && added.length > shownAdded ? added.length : undefined;
    changes.push({ kind: "added", element, words, more });
  });
  const shownRemoved = Math.min(removed.length, Math.max(MAX_CHANGE_LINES - changes.length, 0));
  removed.slice(0, shownRemoved).forEach(({ words }, index) => {
    const more = index + 1 === shownRemoved && removed.length > shownRemoved ? removed.length : undefined;
    changes.push({ kind: "removed", words, more });
  });
  return changes.slice(0, MAX_CHANGE_LINES);
}

/**
 * Whether a change line follows an element: not one numbered only to fill the viewport up (a scroll shows and hides
 * those), nor a dropdown's option (its dropdown's value says what changed).
 */
function followed(element: Element): boolean {
  return element.keep !== Keep.Filled && element.kind.kind !== "shown";
}

/** The states and value of an element that differ between two readings. */
function stateChanges(was: Element, now: Element): [state: string, from: string, to: string][] {
  const stateOf = (element: Element, name: string) => {
    const state = element.states.find(([candidate]) => candidate === name);
    return state ? (state[1] ?? SET) : UNSET;
  };
  const changes: [string, string, string][] = [];
  for (const name of STATES) {
    const [from, to] = [stateOf(was, name), stateOf(now, name)];
    if (from !== to) changes.push([name, from, to]);
  }
  const [from, to] = [held(was), held(now)];
  if (from !== to) changes.push([VALUE_STATE, from, to]);
  return changes;
}

/** What a box or a dropdown holds, as a change line writes it. */
function held(element: Element): string {
  let text = "";
  if (element.kind.kind === "select") text = element.kind.options.find((option) => option.selected)?.text ?? "";
  else if (element.secretLength !== undefined) text = SECRET_CHARACTER.repeat(element.secretLength);
  else if (element.value !== undefined) text = element.value;
  return text === "" ? EMPTY_VALUE : cut(text, CHANGE_TEXT_CHARS);
}

/** What an element is, whatever node draws it: its role, name and link. */
function whatOf(element: Element): string {
  return JSON.stringify([element.role, element.name, element.href ?? ""]);
}

/**
 * The followed elements of `after` that were on the page `before`, each with its index there: the same node with the
 * same role, name and link first; then, of the rest, by role, name and link, the first such in page order with the
 * first, the second with the second (a page that drew them anew).
 */
function paired(before: PageTree, after: PageTree): Map<number, number> {
  const earlier = new Map<string, { index: number; what: string }>();
  before.elements.forEach((element, index) => {
    if (followed(element)) earlier.set(bindingKey(element.binding), { index, what: whatOf(element) });
  });
  const pairs = new Map<number, number>();
  after.elements.forEach((element, index) => {
    const was = followed(element) ? earlier.get(bindingKey(element.binding)) : undefined;
    if (was && was.what === whatOf(element)) pairs.set(index, was.index);
  });
  const kept = new Set(pairs.values());
  const waiting = new Map<string, number[]>();
  before.elements.forEach((element, index) => {
    if (!followed(element) || kept.has(index)) return;
    const what = whatOf(element);
    const queue = waiting.get(what);
    if (queue) queue.push(index);
    else waiting.set(what, [index]);
  });
  after.elements.forEach((element, index) => {
    if (!followed(element) || pairs.has(index)) return;
    const was = waiting.get(whatOf(element))?.shift();
    if (was !== undefined) pairs.set(index, was);
  });
  return pairs;
}

/**
 * What `later` has that `earlier` did not, in page order: elements not among those `kept` (by index in `later`),
 * regions, headings and texts by what they say.
 */
function appeared(
  earlier: PageTree,
  later: PageTree,
  kept: ReadonlySet<number>,
): { element: Named | undefined; words: string }[] {
  const before = new Map<string, number>();
  for (const { line } of earlier.lines) {
    const words = lineWords(line);
    if (words !== undefined) add(before, words);
  }
  const seenElements = new Set<number>();
  const found: { element: Named | undefined; words: string }[] = [];
  for (const { line } of later.lines) {
    if (line.kind === "element") {
      const element = later.elements[line.element]!;
      if (!followed(element) || kept.has(line.element) || seenElements.has(line.element)) continue;
      seenElements.add(line.element);
      found.push({ element: named(element), words: elementWords(element, SHORT_NAME_CHARS) });
      continue;
    }
    const words = lineWords(line);
    if (words === undefined) continue;
    const count = before.get(words) ?? 0;
    if (count > 0) before.set(words, count - 1);
    else found.push({ element: undefined, words });
  }
  return found;
}

/** A region's, heading's or text's line as change lines name it. */
export function lineWords(line: Line): string | undefined {
  switch (line.kind) {
    case "region":
      return line.name === "" ? line.role : `${line.role} ${cut(line.name, SHORT_NAME_CHARS)}`;
    case "heading":
      return `${HEADING} ${cut(line.name, CHANGE_TEXT_CHARS)}`;
    case "text":
      return `${TEXT} ${cut(line.text, CHANGE_TEXT_CHARS)}`;
    default:
      return undefined;
  }
}
