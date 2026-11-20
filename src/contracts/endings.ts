/**
 * The endings a run can end on besides DONE: the key the decision model chooses, and the status the run's result
 * carries (the key in lower case). The same words go from the model's option to the result.
 */

/** The endings, in the order the model is offered them. */
export const ENDINGS = [
  "NEEDS_FROM_PERSON",
  "NEEDS_APPROVAL",
  "SITE_CANNOT",
  "BLOCKED",
  "PAGE_UNUSABLE",
  "OTHER_FAILURE",
] as const;

export type EndingKey = (typeof ENDINGS)[number];

/** Whether an option key is an ending's. */
export function isEnding(key: string): key is EndingKey {
  return (ENDINGS as readonly string[]).includes(key);
}

/** The status of an ending. */
export function endingStatus(key: EndingKey): Lowercase<EndingKey> {
  return key.toLowerCase() as Lowercase<EndingKey>;
}
