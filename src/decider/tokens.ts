/**
 * Counting tokens as the requests the model was trained on were counted: characters per token, rounded up. Every
 * text is counted on its own, the way the request's pieces add up.
 */

import { length } from "../text.ts";

/** Characters per token when a model's profile gives no ratio of its own. */
export const DEFAULT_CHARS_PER_TOKEN = 3;

/** A text's tokens. */
export type Counter = (text: string) => number;

/** A counter by characters per token. */
export function estimate(charsPerToken: number): Counter {
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return (text) => Math.ceil(length(text) / ratio);
}
