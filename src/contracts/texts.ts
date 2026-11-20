/**
 * The words the requests are made of, by code. They belong to the model: it was trained on requests written with one
 * set of them, so a model's profile gives them and the code holds only the codes. A text fills its `{{name}}` places
 * with the values code gives.
 */

/** The decision model's questions. */
export const DECIDER_STEP = "decider.step";
export const DECIDER_LOOPING = "decider.looping";
export const DECIDER_VALUE = "decider.value";
export const DECIDER_OPTION = "decider.option";
/** The options of a step on the page as a whole. */
export const OPTION_PAGE_SCROLL_DOWN = "option.page_scroll_down";
export const OPTION_PAGE_SCROLL_UP = "option.page_scroll_up";
/** The page as the model reads it. */
export const PAGE_SECRET_VALUE = "page.secret_value";
export const PAGE_MORE_ELEMENTS = "page.more_elements";
export const PAGE_MORE_CLICKABLE = "page.more_clickable";
export const PAGE_SUMMARY = "page.summary";
export const PAGE_OPTIONS_LEFT_OUT = "page.options_left_out";
export const PAGE_UNREADABLE = "page.unreadable";
export const PAGE_TRIED = "page.tried";
/** Recent actions, what came of each. */
export const EFFECT_NO_CHANGE = "effect.no_change";
export const EFFECT_CHANGED = "effect.changed";
export const EFFECT_GONE = "effect.gone";
export const EFFECT_NO_VALUE_FITS = "effect.no_value_fits";
export const EFFECT_NO_OPTION_FITS = "effect.no_option_fits";
export const EFFECT_COVERED = "effect.covered";
export const EFFECT_HIDDEN = "effect.hidden";
export const EFFECT_NOT_A_FIELD = "effect.not_a_field";
export const EFFECT_NOT_A_VALUE = "effect.not_a_value";
export const EFFECT_NOT_TAKEN = "effect.not_taken";
export const EFFECT_FAILED = "effect.failed";
export const EFFECT_UNKNOWN = "effect.unknown";
export const EFFECT_CAPTCHA_SOLVED = "effect.captcha_solved";
export const EFFECT_CAPTCHA_NOT_SOLVED = "effect.captcha_not_solved";
export const EFFECT_NO_CAPTCHA = "effect.no_captcha";
export const EFFECT_MORE_APPEARED = "effect.more_appeared";
export const EFFECT_MORE_REMOVED = "effect.more_removed";

/** The text code of a whole-page step's or an ending's option. */
export function optionCode(key: string): string {
  return `option.${key}`;
}

export function endingCode(key: string): string {
  return `ending.${key}`;
}

/** The words of a model's profile. */
export class Texts {
  private readonly words: ReadonlyMap<string, string>;

  constructor(words: Readonly<Record<string, string>>) {
    this.words = new Map(Object.entries(words));
  }

  /** The text of a code; empty for a code the profile does not give. */
  get(code: string): string {
    return this.words.get(code) ?? "";
  }

  /** The text of a code with each `{{name}}` filled with its value, one name after another. */
  fill(code: string, values: Readonly<Record<string, string>>): string {
    return fill(this.get(code), values);
  }
}

/** `text` with each `{{name}}` of `values` replaced by its value, one name after another. */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  let filled = text;
  for (const [name, value] of Object.entries(values)) filled = filled.replaceAll(`{{${name}}}`, () => value);
  return filled;
}
