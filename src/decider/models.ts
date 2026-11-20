/**
 * What each decision model takes, by its name: the requests to it are packed to these limits, and an attempt at it is
 * given this long. A model the table does not name gets the most cautious limits of the known ones.
 */

export interface ModelLimits {
  /** The context window, and the part of it kept for the answer, in tokens. */
  contextWindow: number;
  maxOutputTokens: number;
  /** The most options one question may have. */
  maxChoices: number;
  /** How the requests' tokens are counted: characters a token. */
  charsPerToken: number;
  /** How long one attempt may take, in ms. */
  attemptMs: number;
}

const CHARS_PER_TOKEN = 3;
const MAX_CHOICES = 255;
/** Hosted models answer over the internet and under load: an attempt is given 30 s: two fit in a decision. */
const HOSTED_ATTEMPT_MS = 30_000;
/** A model served on your own machines answers in well under a second. */
const OWN_ATTEMPT_MS = 10_000;

/** The decision models OpenRouter hosts; they publish no limits: these are the ones they were run with. */
const HOSTED: ModelLimits = {
  contextWindow: 262_144,
  maxOutputTokens: 1_024,
  maxChoices: MAX_CHOICES,
  charsPerToken: CHARS_PER_TOKEN,
  attemptMs: HOSTED_ATTEMPT_MS,
};

/** Karpo Decision 27B Act: the context it was trained with. */
const DECISION_27B_ACT: ModelLimits = {
  contextWindow: 32_768,
  maxOutputTokens: 768,
  maxChoices: MAX_CHOICES,
  charsPerToken: CHARS_PER_TOKEN,
  attemptMs: OWN_ATTEMPT_MS,
};

export const MODEL_LIMITS: Readonly<Record<string, ModelLimits>> = {
  "karpo-decision-27b-act": DECISION_27B_ACT,
  "typesafe/jev-1.14": HOSTED,
  "google/gemini-decision-1": HOSTED,
  "openai/gpt-6-luna-decisions": HOSTED,
};

/** A model the table does not name: the smallest context of the known ones, and a hosted model's patience. */
export const UNKNOWN_MODEL_LIMITS: ModelLimits = { ...DECISION_27B_ACT, attemptMs: HOSTED_ATTEMPT_MS };

export function limitsOf(model: string): ModelLimits {
  return Object.hasOwn(MODEL_LIMITS, model) ? (MODEL_LIMITS[model] ?? UNKNOWN_MODEL_LIMITS) : UNKNOWN_MODEL_LIMITS;
}
