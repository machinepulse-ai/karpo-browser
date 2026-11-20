/**
 * A model's profile: what its requests are written with. The decision model reads pages well only as the requests it
 * was trained on wrote them, so the words of the questions and options, the reading's switches and the limits the
 * requests were packed to belong to the model, not to the code.
 */

import defaultProfile from "./profiles/default.json" with { type: "json" };
import type { ReadingSettings } from "./reading/tree.ts";

export interface Profile {
  name: string;
  /** What the model takes: its context window and the output it keeps of it, the most options of one question, and
   * how its requests' tokens were counted. */
  decider: { contextWindow: number; maxOutputTokens: number; maxChoices: number; charsPerToken: number };
  /** When a run ends by itself. */
  limits: { maxSteps: number; runSeconds: number };
  /**
   * When a run is going in circles: judged so by the model at `threshold` or above `streak` times in a row, or
   * brought back to the same page state for the `arrivals`-th time with nothing new since it was last there.
   */
  looping: { threshold: number; streak: number; arrivals: number };
  reading: ReadingSettings;
  /** The words of the requests, by code. */
  texts: Record<string, string>;
}

/** The default profile: the words the decision models are asked in, and the limits of the smallest one. */
export const DEFAULT_PROFILE: Profile = defaultProfile;
