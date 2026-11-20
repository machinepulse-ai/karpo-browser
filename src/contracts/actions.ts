/**
 * The steps the decision model chooses among, as their option keys write them: an operation on one element
 * (`CLICK 5`, `FILL 61`, `SELECT 9`, `PRESS_ENTER 61`), a scroll of the page or of a scroll area (`SCROLL_DOWN 1`,
 * the page being 1), a step on the page as a whole, and DONE.
 */

/** An element's operations; which an element is offered follows from its kind. */
export const CLICK = "CLICK";
export const FILL = "FILL";
export const SELECT = "SELECT";
export const PRESS_ENTER = "PRESS_ENTER";
/** Scrolls of the page (number 1) or of one scroll area. */
export const SCROLL_DOWN = "SCROLL_DOWN";
export const SCROLL_UP = "SCROLL_UP";
/** Steps on the page as a whole. */
export const WAIT = "WAIT";
export const ESCAPE = "ESCAPE";
export const REFRESH = "REFRESH";
export const SOLVE_CAPTCHA = "SOLVE_CAPTCHA";
/** The page before in this tab, or the page that opened this tab. */
export const BACK = "BACK";
/** Everything the goal asks for is on the page. */
export const DONE = "DONE";

/** The number the page itself has as a scroll target. */
export const PAGE_NUMBER = 1;

/**
 * The steps on the page as a whole, in the order the model is offered them (after the elements' and the scrolls',
 * before the endings and DONE).
 */
export const PAGE_STEPS = [WAIT, ESCAPE, REFRESH, SOLVE_CAPTCHA, BACK] as const;

/** An option's key: the operation and the number it acts on. */
export function optionKey(operation: string, number: number): string {
  return `${operation} ${number}`;
}

/** An option key read back: its operation and the number it names, if any. */
export function readKey(key: string): { operation: string; number: number | undefined } {
  const space = key.indexOf(" ");
  if (space < 0) return { operation: key, number: undefined };
  const digits = key.slice(space + 1);
  const number = /^\+?\d+$/.test(digits) ? Number(digits) : Number.NaN;
  return { operation: key.slice(0, space), number: number <= 0xffff_ffff ? number : undefined };
}
