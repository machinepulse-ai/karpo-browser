/**
 * Text as the reading counts and compares it. The decision model was trained on requests written by a reader that
 * counts characters as Unicode code points and takes Unicode's White_Space as white space; JavaScript's own
 * `length`, `trim` and `\s` differ (UTF-16 units; U+FEFF but not U+0085), so the reading uses these.
 */

/** Unicode White_Space, as the body of a character class. */
const WHITE_SPACE = "\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITE_SPACE_RUN = new RegExp(`[${WHITE_SPACE}]+`);
const AROUND = new RegExp(`^[${WHITE_SPACE}]+|[${WHITE_SPACE}]+$`, "g");
const ASCII_UPPER = /[A-Z]/g;
/** A decimal number as a strict parser reads it: digits with an optional fraction and exponent, nothing around. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INFINITE = /^([+-]?)(?:inf|infinity)$/i;
const NOT_A_NUMBER = /^[+-]?nan$/i;
const INTEGER = /^[+-]?\d+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** What marks a text cut short. */
export const ELLIPSIS = "…";

/** The words of a text: what white space separates. */
export function words(text: string): string[] {
  return text.split(WHITE_SPACE_RUN).filter((word) => word !== "");
}

/** White space collapsed to single spaces, none around. */
export function collapse(text: string): string {
  return words(text).join(" ");
}

/** The text without the white space around it. */
export function trim(text: string): string {
  return text.replace(AROUND, "");
}

/** How many characters (code points) a text has. */
export function length(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The first `count` characters of a text. */
export function take(text: string, count: number): string {
  if (text.length <= count) return text;
  let kept = "";
  let taken = 0;
  for (const character of text) {
    if (taken >= count) break;
    kept += character;
    taken += 1;
  }
  return kept;
}

/** A text cut to `max` characters, an ellipsis where it was cut. */
export function cut(text: string, max: number): string {
  if (text.length <= max || length(text) <= max) return text;
  return take(text, Math.max(max - 1, 0)) + ELLIPSIS;
}

/** The text with its ASCII capitals in lower case, every other character as it is. */
export function asciiLower(text: string): string {
  return text.replace(ASCII_UPPER, (letter) => letter.toLowerCase());
}

/** Whether two texts are the same but for the case of their ASCII letters. */
export function sameButAsciiCase(a: string, b: string): boolean {
  return a.length === b.length && asciiLower(a) === asciiLower(b);
}

/** The number a text writes whole (no white space, no unit); undefined when it writes none. */
export function decimal(text: string): number | undefined {
  if (DECIMAL.test(text)) return Number(text);
  const infinite = INFINITE.exec(text);
  if (infinite) return infinite[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return NOT_A_NUMBER.test(text) ? Number.NaN : undefined;
}

/** The 64-bit integer a text writes whole; undefined when it writes none. */
export function integer(text: string): bigint | undefined {
  if (!INTEGER.test(text)) return undefined;
  const value = BigInt(text);
  return value >= INT64_MIN && value <= INT64_MAX ? value : undefined;
}
