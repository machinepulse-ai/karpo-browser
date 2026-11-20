/**
 * What whoever watches a task is told of a text a show brought into view (ControlOptions.showEvidence): the page's
 * lines around the first one that holds it, few enough to be read as one piece of evidence, with the page's title and
 * address. The line is looked for as a show looks for the text (browser/reveal.ts): as it is written (case, thousands
 * separators and runs of spaces aside), then with its punctuation folded, then by each amount it holds alone that says
 * what it is, the longest first.
 */
import { normalized } from "./grounding.ts";
import { ELLIPSIS, length } from "./text.ts";

/** The most characters of the page's lines an excerpt gives. */
const EXCERPT_MOST_CHARS = 400;
/** Words and amounts, as a text is folded: an amount keeps its currency, decimals and percent sign. */
const FOLDED = /[$€£¥₹]?\d+(?:\.\d+)?%?|\p{L}+/gu;
/** An amount of a text, with a currency, a percent sign or a unit when it has one. */
const AMOUNT = /[$€£¥₹]?\d+(?:\.\d+)?(?:%|\/[a-z]+)?/g;
/** What makes an amount say what it is: a currency, decimals, a percent sign or a unit (a bare number is everywhere). */
const SAYS_WHAT = /[$€£¥₹.%/]/;

/** A page as read: its address, its title and its lines. */
export interface ReadPage {
  url: string;
  title: string;
  lines: readonly string[];
}

/** Where a text is on the page: the line that holds it, and where in that line, trimmed, it begins. */
interface Found {
  line: number;
  at: number;
}

/** Where `wanted`, words and amounts, stand in a row in `text` (normalized), other punctuation aside; -1, if nowhere. */
function foldedAt(text: string, wanted: readonly string[]): number {
  const words = [...text.matchAll(FOLDED)];
  for (let first = 0; first + wanted.length <= words.length; first++) {
    if (wanted.every((word, index) => words[first + index]![0] === word)) return words[first]!.index;
  }
  return -1;
}

/**
 * Where `value` stands alone in `text`: no digit or decimal point just before it, no digit or decimals after it; -1, if
 * nowhere.
 */
function valueAt(text: string, value: string): number {
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    if (!/[\d.]/.test(text[at - 1] ?? "") && !/^\.?\d/.test(text.slice(at + value.length))) return at;
  }
  return -1;
}

/** Where in `text` the character at `at` of normalized(text) is written: its commas dropped, runs of spaces as one. */
function writtenAt(text: string, at: number): number {
  let seen = 0;
  let space = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === ",") continue;
    const white = /\s/.test(char);
    if (white && space) continue;
    if (seen >= at) return index;
    space = white;
    seen += white ? 1 : char.toLowerCase().length;
  }
  return text.length;
}

/** A part's first line ("viewport (scrolled …):", "below:"): the page's own lines are indented under it. */
function partHeader(line: string): boolean {
  return !/^\s/.test(line);
}

/**
 * The first of the page's own lines that holds the text, as it is written, folded, or by an amount, and where in it the
 * text begins; none, if none does.
 */
function find(lines: readonly string[], wanted: string): Found | undefined {
  const plain = normalized(wanted).trim();
  // Each finder gives where in a line, normalized, the text begins, as indexOf does: -1 where it is not.
  const finders: ((text: string) => number)[] = [(text) => text.indexOf(plain)];
  const folded = normalized(wanted).match(FOLDED) ?? [];
  // A text without words ("$350") is left to its amounts: its punctuation is all that tells it apart.
  if (folded.some((word) => /\p{L}/u.test(word))) finders.push((text) => foldedAt(text, folded));
  const amounts = new Set((plain.match(AMOUNT) ?? []).filter((value) => SAYS_WHAT.test(value)));
  for (const value of [...amounts].sort((a, b) => b.length - a.length)) {
    finders.push((text) => valueAt(text, value));
  }
  for (const finder of finders) {
    for (let line = 0; line < lines.length; line++) {
      if (partHeader(lines[line]!)) continue;
      const written = lines[line]!.trim();
      const at = finder(normalized(written));
      if (at >= 0) return { line, at: writtenAt(written, at) };
    }
  }
  return undefined;
}

/**
 * The line, or as much of it as EXCERPT_MOST_CHARS holds with the character at `at` in its middle (moved in from the
 * line's ends), an ellipsis where it was cut: a long paragraph keeps the words around the text, wherever it is.
 */
function excerpt(line: string, at: number): string {
  const chars = [...line];
  if (chars.length <= EXCERPT_MOST_CHARS) return line;
  const middle = length(line.slice(0, at));
  const start = Math.max(Math.min(middle - EXCERPT_MOST_CHARS / 2, chars.length - EXCERPT_MOST_CHARS), 0);
  const end = start + EXCERPT_MOST_CHARS;
  const head = start > 0 ? ELLIPSIS : "";
  const tail = end < chars.length ? ELLIPSIS : "";
  return head + chars.slice(start + head.length, end - tail.length).join("") + tail;
}

/**
 * The line where the text was found and its neighbours in its part, one above and one below in turn, as many as
 * EXCERPT_MOST_CHARS holds.
 */
function around(lines: readonly string[], found: Found): string[] {
  const line = (index: number) => lines[index]!.trim();
  let first = found.line;
  let last = found.line;
  let chars = Math.min(line(found.line).length, EXCERPT_MOST_CHARS);
  const fits = (index: number) =>
    index >= 0 &&
    index < lines.length &&
    !partHeader(lines[index]!) &&
    chars + 1 + line(index).length <= EXCERPT_MOST_CHARS;
  for (let up = true, down = true; up || down; ) {
    up &&= fits(first - 1);
    if (up) chars += 1 + line(--first).length;
    down &&= fits(last + 1);
    if (down) chars += 1 + line(++last).length;
  }
  return lines
    .slice(first, last + 1)
    .map((each, index) => (first + index === found.line ? excerpt(each.trim(), found.at) : each.trim()));
}

/**
 * What whoever watches is told of a text a show brought into view (`said`): on which page, the lines around it, and the
 * page's address last, so that a reader of the first few hundred characters still gets the lines.
 */
export function evidenceText(said: string, page: ReadPage, wanted: string): string {
  const on = page.title ? `${said} on ${page.title}` : said;
  const found = find(page.lines, wanted);
  if (found === undefined) return `${on} (${page.url})`;
  return `${on}:\n${around(page.lines, found).join("\n")}\n(${page.url})`;
}
