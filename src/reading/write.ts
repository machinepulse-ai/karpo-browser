/**
 * The page tree written as the decision model reads it, one array item a line:
 *
 * ```text
 * viewport (scrolled 629/2373px):
 *   banner
 *     4 link TableCheck logo href=/en/japan
 *     search
 *       5 button Destination Area, station, line or restaurant [expanded=false]
 *   text Please kindly note the deposit is going to be 5,000/JPY per person.
 * above:
 *   banner
 *     2 link For restaurateurs href=/en/join/
 * below:
 *   35 link Private room href=/en/shops/ushigoro-ginza/reserve
 * ```
 *
 * An element is "number role name [states] href=…"; regions, headings and text are not numbered. What the request
 * leaves out (the packing's choice) is left out here; a part off the screen may be given as a summary.
 */

import type { Texts } from "../contracts/texts.ts";
import {
  PAGE_MORE_CLICKABLE,
  PAGE_MORE_ELEMENTS,
  PAGE_OPTIONS_LEFT_OUT,
  PAGE_SECRET_VALUE,
  PAGE_SUMMARY,
  PAGE_UNREADABLE,
} from "../contracts/texts.ts";
import { cut } from "../text.ts";
import type { Element, PageTree, Part, ReadingSettings } from "./tree.ts";
import { acts, Keep, optionsWindow, PARTS, TEXT_MAX_CHARS } from "./tree.ts";

/** How far one level indents. */
export const INDENT = "  ";
/** The words of the format itself: a part's header, a line's kind. */
const VIEWPORT = "viewport";
const PAGE = "page";
const ABOVE = "above:";
const BELOW = "below:";
const HEADING = "heading";
const TEXT = "text";
const TEXT_PART = "text:";
const CLICKABLE_MARK = "[clickable]";
const POINTER_MARK = "[pointer]";
const SCROLLABLE_MARK = "[scrollable]";
export const OFFSCREEN_ABOVE = "· offscreen above";
export const OFFSCREEN_BELOW = "· offscreen below";
/** The longest name an option's description gives. */
export const SHORT_NAME_CHARS = 40;
/** How many of a summarized region's elements, the nearest to the viewport, the summary names. */
const SUMMARY_NEAREST = 4;
/** The longest name a line writes. */
const LINE_NAME_CHARS = 200;
/** What a summary calls the elements outside any region. */
const PAGE_REGION = "page";

/** How much of a part off the screen the request gives. */
export type Shown = "whole" | "summary" | "nothing";

/** What the request gives of the tree: lines left out, and how the parts off the screen are given. */
export interface Selection {
  leftOut: ReadonlySet<number>;
  above: Shown;
  below: Shown;
}

/** Everything. */
export function wholeSelection(): Selection {
  return { leftOut: new Set(), above: "whole", below: "whole" };
}

function shownOf(selection: Selection, part: Part): Shown {
  return part === "viewport" ? "whole" : selection[part];
}

/** The page as the request writes it: its lines, and the elements offered (by index), each once. */
export interface Written {
  lines: string[];
  offered: number[];
}

/** What an element's line ends with besides its own facts, by element: what was tried on it in this page state. */
export type Marks = ReadonlyMap<number, string>;

/** The lines of a part that are written as lines of their own: all but the regions. */
function linesOf(tree: PageTree, part: Part | undefined): number[] {
  const lines: number[] = [];
  tree.lines.forEach((line, index) => {
    if ((part === undefined || line.part === part) && line.line.kind !== "region") lines.push(index);
  });
  return lines;
}

/** Writes the tree as the selection gives it. */
export function writePage(
  tree: PageTree,
  selection: Selection,
  marks: Marks,
  reading: ReadingSettings,
  texts: Texts,
): Written {
  const written: Written = { lines: [], offered: [] };
  const parts: readonly Part[] = reading.viewportParts ? PARTS : ["viewport"];
  for (const part of parts) {
    const lines = linesOf(tree, reading.viewportParts ? part : undefined);
    const shown = shownOf(selection, part);
    if (lines.length === 0 || shown === "nothing") continue;
    written.lines.push(header(part, tree, reading));
    if (shown === "summary") {
      summarize(tree, part, lines, selection, texts, written);
      continue;
    }
    const open: number[] = [];
    const textsApart: string[] = [];
    for (const index of lines) {
      const line = tree.lines[index]!;
      // One tree of the whole page still holds the parts off the screen to what the selection gives of them.
      if (selection.leftOut.has(index) || shownOf(selection, line.part) !== "whole") continue;
      if (!reading.textInTree && line.line.kind === "text") {
        textsApart.push(lineText(tree, index, marks, texts, true));
        continue;
      }
      const depth = reading.regionTree ? openRegions(tree, index, open, written.lines) : 0;
      let text = INDENT.repeat(depth + 1) + lineText(tree, index, marks, texts, true);
      if (!reading.viewportParts && line.part !== "viewport") {
        text = `${text} ${line.part === "above" ? OFFSCREEN_ABOVE : OFFSCREEN_BELOW}`;
      }
      written.lines.push(text);
      if (line.line.kind === "element") {
        const element = tree.elements[line.line.element]!;
        if (acts(element)) written.offered.push(line.line.element);
        const more = moreOptions(element, reading, texts);
        if (more !== undefined) written.lines.push(INDENT.repeat(depth + 2) + more);
      }
    }
    if (textsApart.length > 0) {
      written.lines.push(INDENT + TEXT_PART);
      for (const text of textsApart) written.lines.push(INDENT + INDENT + text);
    }
    if (part === "viewport") {
      for (const note of cutNotes(tree, selection, texts)) written.lines.push(INDENT + note);
    }
  }
  if (!reading.viewportParts) {
    // A part off the screen given as a summary follows the tree, as the parts would write it.
    for (const part of ["above", "below"] as const) {
      const lines = linesOf(tree, part);
      if (shownOf(selection, part) !== "summary" || lines.length === 0) continue;
      written.lines.push(header(part, tree, reading));
      summarize(tree, part, lines, selection, texts, written);
    }
  }
  return written;
}

/** A number with no fraction digits, a half rounded to the even neighbour. */
function whole(n: number): string {
  const floor = Math.floor(n);
  const fraction = n - floor;
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  if (!Number.isFinite(rounded)) return Number.isNaN(rounded) ? "NaN" : rounded > 0 ? "inf" : "-inf";
  return rounded === 0 && (n < 0 || Object.is(n, -0)) ? "-0" : BigInt(rounded).toString();
}

/** A part's first line. */
function header(part: Part, tree: PageTree, reading: ReadingSettings): string {
  if (part === "above") return ABOVE;
  if (part === "below") return BELOW;
  const name = reading.viewportParts ? VIEWPORT : PAGE;
  return `${name} (scrolled ${whole(tree.scroll.top)}/${whole(tree.scroll.maxTop)}px):`;
}

/**
 * Writes the region lines a line is under that are not open yet (a region shows again in each part it spans); the
 * line's depth.
 */
export function openRegions(tree: PageTree, index: number, open: number[], out: string[]): number {
  const chain: number[] = [];
  for (let parent = tree.lines[index]!.parent; parent !== undefined; parent = tree.lines[parent]!.parent) {
    chain.push(parent);
  }
  chain.reverse();
  let shared = 0;
  while (shared < open.length && shared < chain.length && open[shared] === chain[shared]) shared += 1;
  open.length = shared;
  for (const at of chain.slice(shared)) {
    const line = tree.lines[at]!.line;
    if (line.kind === "region") out.push(INDENT.repeat(open.length + 1) + regionText(line.role, line.name));
    open.push(at);
  }
  return open.length;
}

function regionText(role: string, name: string): string {
  return name === "" ? role : `${role} ${name}`;
}

/** One line's text, without its indent; `whole` writes an element's name up to the line's limit. */
export function lineText(tree: PageTree, index: number, marks: Marks, texts: Texts, whole: boolean): string {
  const line = tree.lines[index]!.line;
  switch (line.kind) {
    case "region":
      return regionText(line.role, line.name);
    case "heading":
      return `${HEADING} ${line.name}`;
    case "text":
      return `${TEXT} ${line.text}`;
    case "unreadable":
      return `${line.what} [${texts.get(PAGE_UNREADABLE)}]`;
    case "element": {
      const element = tree.elements[line.element]!;
      const max = !whole ? SHORT_NAME_CHARS : element.words ? TEXT_MAX_CHARS : LINE_NAME_CHARS;
      const mark = marks.get(line.element);
      const text = elementLine(element, texts, max);
      return mark === undefined ? text : `${text} · ${mark}`;
    }
  }
}

/** An element's line: "number role name [states] href=…", the name cut to `max` characters. */
export function elementLine(element: Element, texts: Texts, max: number): string {
  let text = `${element.number} ${elementWords(element, max)}`;
  for (const [state, value] of element.states) text += value === undefined ? ` [${state}]` : ` [${state}=${value}]`;
  if (element.kind.kind === "select") {
    const selected = element.kind.options.find((option) => option.selected)?.text ?? "";
    text += ` [value=${selected}]`;
  } else if (element.secretLength !== undefined) {
    text += ` [value=${texts.fill(PAGE_SECRET_VALUE, { n: String(element.secretLength) })}]`;
  } else if (element.value !== undefined) {
    text += ` [value=${cut(element.value, LINE_NAME_CHARS)}]`;
  }
  if (element.href !== undefined) text += ` href=${element.href}`;
  if (element.clickable) text += ` ${CLICKABLE_MARK}`;
  if (element.pointer) text += ` ${POINTER_MARK}`;
  if (element.kind.kind === "scroll") text += ` ${SCROLLABLE_MARK}`;
  return text;
}

/**
 * "role name", the name cut to `max` characters: what an option's description and a recent action name an element
 * by.
 */
export function elementWords(element: Element, max: number): string {
  const name = cut(element.name, max);
  return name === "" ? element.role : `${element.role} ${name}`;
}

/** The note under a dropdown whose options are not all listed: how many come before the listed ones, and after. */
function moreOptions(element: Element, reading: ReadingSettings, texts: Texts): string | undefined {
  if (element.kind.kind !== "select") return undefined;
  const options = element.kind.options;
  const window = optionsWindow(options, Math.max(reading.selectOptionsListed, 0));
  const before = window.start;
  const after = options.length - window.end;
  if (before + after === 0) return undefined;
  return texts.fill(PAGE_OPTIONS_LEFT_OUT, { before: String(before), after: String(after) });
}

/** The notes after the viewport's lines when some of its elements were left out. */
function cutNotes(tree: PageTree, selection: Selection, texts: Texts): string[] {
  let filled = 0;
  let clickable = 0;
  for (const index of selection.leftOut) {
    const line = tree.lines[index]!;
    if (line.part !== "viewport" || line.line.kind !== "element") continue;
    if (tree.elements[line.line.element]!.keep === Keep.Filled) filled += 1;
    else clickable += 1;
  }
  if (clickable > 0) return [texts.fill(PAGE_MORE_CLICKABLE, { n: String(clickable + filled) })];
  return filled > 0 ? [texts.fill(PAGE_MORE_ELEMENTS, { n: String(filled) })] : [];
}

/**
 * A part off the screen as a summary: each top-level region with how many elements it holds and the ones nearest the
 * viewport, which stay offered.
 */
function summarize(
  tree: PageTree,
  part: Part,
  lines: readonly number[],
  selection: Selection,
  texts: Texts,
  written: Written,
): void {
  const regions = new Map<string, number[]>();
  for (const index of lines) {
    const line = tree.lines[index]!.line;
    if (selection.leftOut.has(index) || line.kind !== "element" || !acts(tree.elements[line.element]!)) continue;
    const region = topRegion(tree, index);
    const elements = regions.get(region);
    if (elements) elements.push(line.element);
    else regions.set(region, [line.element]);
  }
  for (const [region, elements] of regions) {
    const nearest = part === "above" ? elements.slice(-SUMMARY_NEAREST) : elements.slice(0, SUMMARY_NEAREST);
    const named = nearest.map((element) => elementLine(tree.elements[element]!, texts, SHORT_NAME_CHARS));
    written.lines.push(
      INDENT + texts.fill(PAGE_SUMMARY, { region, n: String(elements.length), nearest: named.join("; ") }),
    );
    written.offered.push(...nearest);
  }
}

/** The outermost region a line is under, as a summary names it. */
function topRegion(tree: PageTree, index: number): string {
  let top = PAGE_REGION;
  for (let parent = tree.lines[index]!.parent; parent !== undefined; parent = tree.lines[parent]!.parent) {
    const line = tree.lines[parent]!.line;
    if (line.kind === "region") top = regionText(line.role, line.name);
  }
  return top;
}
