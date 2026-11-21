/**
 * A slider set to the value a task asks, by what the slider shows a person: its own words for its value
 * (aria-valuetext: "Fri, 02:00 PM", "8,000 subscribers") when it has them, else the value. Many sliders count in
 * steps of their own (0 to 32 for the half hours of a day) and show the value in words, so the number in a task's
 * text is no value to set: the slider is at the value asked when what it shows says so.
 *
 * Checked on 26 pages with sliders on 2026-11-20 (14 component libraries' demos and 11 sites): of 24 with standard
 * sliders, 22 show their value on the slider itself; the two that write it only beside the slider (an index or a
 * curve behind "500k") cannot be set by what they show and are left as they were.
 */

import { member, string } from "../json.ts";
import { firstNumber } from "./native-value.ts";

/**
 * What a slider holds, read from the element: null when it is no slider. A native range holds its value; any other
 * slider (role=slider) its aria-valuenow.
 */
export const SLIDER_STATE = `function () {
  const native = this instanceof HTMLInputElement && this.type === "range";
  const role = (this.getAttribute("role") || "").trim().toLowerCase().split(/\\s+/)[0];
  if (!native && role !== "slider") return null;
  const value = native ? this.value : this.getAttribute("aria-valuenow");
  return {
    native,
    value: String(value == null ? "" : value).trim(),
    valueText: (this.getAttribute("aria-valuetext") || "").trim() || null,
    vertical: (this.getAttribute("aria-orientation") || "").toLowerCase() === "vertical",
    disabled: (native && (this.disabled || this.readOnly)) || this.getAttribute("aria-disabled") === "true",
    focused: (this.getRootNode().activeElement || null) === this,
  };
}`;

/** A slider's state (`SLIDER_STATE`). */
export interface SliderState {
  /** A native range, whose value is set through the element; else a slider the page draws, moved by keys. */
  native: boolean;
  /** Its value as the element holds it; "" without one. */
  value: string;
  /** Its own words for its value (aria-valuetext), when it has them. */
  valueText: string | undefined;
  vertical: boolean;
  /** It takes no input: disabled or read-only. */
  disabled: boolean;
  /** It has the focus: keys reach it. */
  focused: boolean;
}

/** The state `SLIDER_STATE` answered; undefined for no slider. */
export function readSlider(answer: unknown): SliderState | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  return {
    native: member(answer, "native") === true,
    value: string(member(answer, "value")) ?? "",
    valueText: string(member(answer, "valueText")),
    vertical: member(answer, "vertical") === true,
    disabled: member(answer, "disabled") === true,
    focused: member(answer, "focused") === true,
  };
}

/** Whether two states are the same position: the same value, shown the same. */
export function sameSlider(a: SliderState, b: SliderState): boolean {
  return a.value === b.value && a.valueText === b.valueText;
}

/** What a person reads off the slider: its own words for the value, else the value. */
export function shown(state: SliderState): string {
  return state.valueText ?? state.value;
}

/** A minus sign as number formats of some languages write it (U+2212), as the keyboard's. */
function ascii(text: string): string {
  return text.replaceAll("\u2212", "-");
}

/** A number written by itself ("20", "20.00", "-5", "1,250"). */
const NUMBER_ALONE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/** The number a slider shows, when what it shows is a number alone. */
export function shownNumber(state: SliderState): number | undefined {
  const text = ascii(shown(state)).trim();
  if (!NUMBER_ALONE.test(text)) return undefined;
  const number = Number(text.replaceAll(",", ""));
  return Number.isFinite(number) ? number : undefined;
}

/** The value a task's text asks of a slider: the text, and its number when the text holds one that is the value. */
export interface SliderTarget {
  text: string;
  /**
   * The number asked ("$20", "1,250", "22 years"); none for a time of day ("2:00 PM") or a number with a magnitude
   * ("100K"), whose digits alone are not the value.
   */
  number: number | undefined;
}

/**
 * Texts whose first digits alone are not the value: a time of day ("2:00", "2 PM"), a number that goes on in a letter
 * ("100K"), and thousands written in a way that reads two ways ("1 000", "1.000").
 */
const NOT_A_NUMBER_ALONE = /\d\s*:\s*\d|\d\s*[ap]\.?m\b|\d\p{L}|\d[\s\u00a0\u202f]\d|\d\.\d{3}(?!\d)/iu;

export function sliderTarget(text: string): SliderTarget {
  const asked = ascii(text);
  return { text: asked, number: NOT_A_NUMBER_ALONE.test(asked) ? undefined : firstNumber(asked) };
}

/** How far two numbers may lie apart and be the same value (a slider counting in tenths holds 30.300000000000004). */
const SAME_NUMBER = 1e-9;

/**
 * Words as a person compares them: case and runs of spaces left out of account; thousands written without their
 * separators ("8,000" and "8 000" are "8000"); numbers without leading zeros or empty decimals ("02:00" is "2:00",
 * "$20.00" is "$20"); an hour with no minutes written with them ("2 PM" is "2:00 PM").
 */
function plain(text: string): string {
  return ascii(text)
    .toLowerCase()
    .replace(/(\d)[,\s\u00a0\u202f](?=\d{3}(?!\d))/g, "$1")
    .replace(/(^|[^\p{N}.,:])0+(?=\p{N})/gu, "$1")
    .replace(/(\d)\.0+(?!\d)/g, "$1")
    .replace(/(^|[^\d:.])(\d{1,2})\s*([ap])\.?m\b/g, "$1$2:00 $3m")
    .replace(/\s+/g, " ")
    .trim();
}

/** The characters of a regular expression's own syntax. */
const SYNTAX = /[.*+?^${}()|[\]\\]/g;
/**
 * A letter or digit that runs on into a word beside it. Scripts written without spaces between words (Chinese,
 * Japanese, Korean, Thai) do not: "下午2:00" is in "周五下午2:00".
 */
const RUNS_ON = "[[\\p{L}--[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}]]\\p{N}]";

/**
 * Whether a text holds the words asked as a person reads them: where no letter or digit runs into them at either end
 * ("2:00 PM" is not in "12:00 PM", "500" not in "500K" or "1500", "30" not in "30.5"), spaces between them free
 * ("2:00pm" is "2:00 PM"). Words that begin with a sign ("$500") are held wherever the sign is ("US$500").
 */
function holdsWords(text: string, asked: string): boolean {
  const words = plain(asked);
  if (words === "") return false;
  const pattern = words
    .replace(SYNTAX, "\\$&")
    .replace(/ /g, "\\s*")
    .replace(/(\p{N})(?=\p{L})|(\p{L})(?=\p{N})/gu, "$1$2\\s*");
  const before = /^\p{N}/u.test(words) ? `(?<!${RUNS_ON}|[.:\\-])` : /^\p{L}/u.test(words) ? `(?<!${RUNS_ON})` : "";
  return new RegExp(`${before}${pattern}(?!${RUNS_ON}|[.:,]\\p{N})`, "v").test(plain(text));
}

/**
 * Whether the slider shows the value asked: the number, when it shows a number alone and a number was asked; else the
 * words asked, in what it shows.
 */
export function shows(state: SliderState, target: SliderTarget): boolean {
  const number = shownNumber(state);
  if (target.number !== undefined && number !== undefined) {
    return Math.abs(number - target.number) <= SAME_NUMBER * Math.max(1, Math.abs(target.number));
  }
  return holdsWords(shown(state), target.text);
}

/** How many key presses close a gap at a step, at most `cap`: none within half a step. */
export function pressesFor(gap: number, step: number, cap: number): number {
  if (step <= 0 || Math.abs(gap) <= step / 2) return 0;
  return Math.min(Math.max(Math.round(Math.abs(gap) / step), 1), cap);
}
