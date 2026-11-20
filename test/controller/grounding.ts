/**
 * The values an answer gives that a page must have shown (amounts, percentages, decimals, numbers of three digits or
 * more), checked against the texts the controller read, as an answer checker that wants each stated value seen on a
 * page reads it: a finish is put through it once before it is taken.
 */

/** A value of an answer: an amount with its currency, a percentage, a decimal or a whole number. */
const VALUE = /(?:([$€£¥]|usd|eur|gbp)\s?)?(\d[\d,]*(?:\.\d+)?)(\s?%)?/gi;
/** The fewest digits a whole number without a currency needs to be checked: smaller ones are too common to tell. */
const MIN_DIGITS = 3;
/** The most values one note names. */
const MOST_NAMED = 8;

/** A text as values are looked for in it: lower case, without thousands separators, its spaces single. */
export function normalized(text: string): string {
  return text.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
}

interface Value {
  /** As the answer writes it. */
  text: string;
  /** Its number without separators, and without decimals that are all zeros. */
  core: string;
  percent: boolean;
  /** An amount, a percentage or a decimal: a value a page states, as a bare whole number may not be. */
  stated: boolean;
}

function valuesOf(answer: string): Value[] {
  const found = new Map<string, Value>();
  for (const match of answer.matchAll(VALUE)) {
    const [whole, currency, number, percent] = match;
    if (number === undefined) continue;
    const plain = number.replace(/,/g, "").replace(/\.0+$/, "");
    const decimal = plain.includes(".");
    const stated = Boolean(currency) || Boolean(percent) || decimal;
    if (!stated && plain.replace(/\D/g, "").length < MIN_DIGITS) continue;
    const text = whole.trim().replace(/[,.]+$/, "");
    if (!found.has(text)) found.set(text, { text, core: plain, percent: Boolean(percent), stated });
  }
  return [...found.values()];
}

function shownIn(read: string, value: Value): boolean {
  const core = value.core.replace(/\./g, "\\.");
  const pattern = value.percent
    ? new RegExp(`(?<![\\d.])${core}\\s?%`)
    : new RegExp(`(?<![\\d.])${core}(?:\\.0+)?(?!\\d|\\.\\d)`);
  return pattern.test(read);
}

/** The values of an answer worth checking against the pages, as the answer writes them. */
export function answerValues(answer: string): string[] {
  return valuesOf(answer).map((value) => value.text);
}

/** The amounts, percentages and decimals of an answer, as it writes them: what a page is to be scrolled to. */
export function statedValues(answer: string): string[] {
  return valuesOf(answer)
    .filter((value) => value.stated)
    .map((value) => value.text);
}

/** The values of an answer that `read` (normalized texts the controller read, the task's own words with them) lacks. */
export function unseenValues(answer: string, read: string): string[] {
  return valuesOf(answer)
    .filter((value) => !shownIn(read, value))
    .map((value) => value.text);
}

/** What a finish with values no page showed is answered: check them, or say how they were worked out. */
export function unseenNote(values: readonly string[]): string {
  const named = values
    .slice(0, MOST_NAMED)
    .map((value) => `"${value}"`)
    .join(", ");
  return `Not finished: no page you read showed ${named}. Check each on its page and bring it into view with show; when you worked a value out from values the pages showed, say how in the answer. Then finish again.`;
}
