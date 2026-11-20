/**
 * Text as the controller counts and cuts it: characters are Unicode code points, as the library's reading counts them
 * (a copy of the few helpers the controller needs, so that it uses only the library's public interface).
 */

/** What marks a text cut short. */
export const ELLIPSIS = "…";

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
