/**
 * System 1 as a browser asks it: a decider given whole, or a System One endpoint named by the options or, where they
 * leave it out, by SYSTEM1_URL, SYSTEM1_MODEL and SYSTEM1_API_KEY (the key is not read when the options give the
 * address); and the limits its requests are packed to.
 */

import { setting } from "../env.ts";
import type { Profile } from "../profile.ts";
import { DEFAULT_PROFILE } from "../profile.ts";
import type { ModelLimits } from "./models.ts";
import { limitsOf, MODEL_LIMITS } from "./models.ts";
import type { Decider, SystemOneOptions } from "./systemone.ts";
import { OPENROUTER_DECISIONS_URL, SystemOneDecider } from "./systemone.ts";

export const URL_VARIABLE = "SYSTEM1_URL";
export const MODEL_VARIABLE = "SYSTEM1_MODEL";
export const API_KEY_VARIABLE = "SYSTEM1_API_KEY";

export interface System1 {
  decider: Decider;
  /** The limits the requests are packed to; none for a decider given whole. */
  limits: ModelLimits | undefined;
}

export function system1Of(given: Decider | Partial<SystemOneOptions> | undefined): System1 {
  if (given && "ask" in given) return { decider: given, limits: undefined };
  const model = given?.model || setting(MODEL_VARIABLE);
  if (!model) {
    throw new Error(
      `no decision model: set ${MODEL_VARIABLE} to one of ${Object.keys(MODEL_LIMITS).join(", ")} or your own ` +
        `model's name, and ${API_KEY_VARIABLE}; ${URL_VARIABLE} is ${OPENROUTER_DECISIONS_URL} unless set, ` +
        `or pass a decider`,
    );
  }
  const url = given?.url || setting(URL_VARIABLE) || OPENROUTER_DECISIONS_URL;
  // A key from the environment goes only to the address the environment names (or OpenRouter's), never to one set in code.
  const apiKey = given?.apiKey || (given?.url ? undefined : setting(API_KEY_VARIABLE));
  const limits = limitsOf(model);
  const decider = new SystemOneDecider({
    url,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(given?.attempts === undefined ? {} : { attempts: given.attempts }),
    attemptTimeoutMs: given?.attemptTimeoutMs ?? limits.attemptMs,
    ...(given?.imagesAsStateItems === undefined ? {} : { imagesAsStateItems: given.imagesAsStateItems }),
  });
  return { decider, limits };
}

/** The profile a run packs its requests by: the one given, else the default with System 1's limits. */
export function profileFor(given: Profile | undefined, limits: ModelLimits | undefined): Profile {
  if (given) return given;
  if (!limits) return DEFAULT_PROFILE;
  const { contextWindow, maxOutputTokens, maxChoices, charsPerToken } = limits;
  return { ...DEFAULT_PROFILE, decider: { contextWindow, maxOutputTokens, maxChoices, charsPerToken } };
}
