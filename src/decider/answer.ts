/**
 * Reading the decision model's answers: the step it chose, the looping judgment, a follow-up's value or option. The
 * model weighs every option; the step is the likeliest, an action or an ending alike, and an ending (or DONE) comes
 * with what the model saw (`note`).
 */

import type { EndingKey } from "../contracts/endings.ts";
import { isEnding } from "../contracts/endings.ts";
import { member, number, string } from "../json.ts";
import { trim } from "../text.ts";
import { LOOPING, NONE, STEP } from "./request.ts";

/** The field of a step answer that holds the model's note. */
export const NOTE = "note";

/** Why an answer could not be read. */
export class AnswerError extends Error {}

function missing(question: string): AnswerError {
  return new AnswerError(`the answer has no ${question} question`);
}

function notOffered(key: string): AnswerError {
  return new AnswerError(`the answer chose ${JSON.stringify(key)}, which was not offered`);
}

function unweighed(question: string): AnswerError {
  return new AnswerError(`the answer to ${question} does not weigh every option it was offered`);
}

/** The step the model chose. */
export interface StepAnswer {
  /** The option the step is. */
  key: string;
  /** The probability of every option, as the model gave them (empty when it gave only its choice). */
  probabilities: Readonly<Record<string, unknown>>;
  /** How surely the run is going in circles, 0 to 1. */
  looping: number | undefined;
  /** The ending the step ends on, when it is one. */
  ending: EndingKey | undefined;
  /** What the model saw that made it end (DONE's evidence, or what is missing or in the way). */
  note: string | undefined;
}

/** The answers of a response: under `answers`, or the response itself. */
function answersOf(answer: unknown): unknown {
  return member(answer, "answers") ?? answer;
}

/** A question's answer: the choice, and the probabilities of its options when the model gave them. */
function choiceOf(
  answers: unknown,
  question: string,
): { choice: string; probabilities: Record<string, unknown> | undefined } {
  const choice = string(member(member(answers, question), "choice"));
  if (choice === undefined) throw missing(question);
  const probabilities = member(member(answers, question), "probabilities");
  const given = typeof probabilities === "object" && probabilities !== null && !Array.isArray(probabilities);
  return { choice, probabilities: given ? (probabilities as Record<string, unknown>) : undefined };
}

/** How likely an answer found an option; 0 for one it did not weigh. */
function weight(probabilities: Readonly<Record<string, unknown>>, key: string): number {
  return Object.hasOwn(probabilities, key) ? (number(probabilities[key]) ?? 0) : 0;
}

/**
 * The step of an answer (`{"answers": {"step": …, "looping": …}}`) to the step question with these options: the
 * likeliest offered option, actions and endings alike (a tie goes to the one offered first); the model's choice when
 * it gave no probabilities. What the model saw when it ended (`note`) comes with it.
 */
export function readStep(answer: unknown, options: readonly string[]): StepAnswer {
  const answers = answersOf(answer);
  const { choice, probabilities = {} } = choiceOf(answers, STEP);
  let key: string | undefined;
  for (const option of options) {
    if (!Object.hasOwn(probabilities, option)) continue;
    if (key === undefined || weight(probabilities, key) < weight(probabilities, option)) key = option;
  }
  key ??= choice;
  if (!options.includes(key)) throw notOffered(key);
  const note = trim(string(member(member(answers, STEP), NOTE)) ?? "");
  return {
    key,
    probabilities,
    looping: number(member(member(answers, LOOPING), "noul")),
    ending: isEnding(key) ? key : undefined,
    note: note === "" ? undefined : note,
  };
}

/** Whether an answer holds an answer to a question. */
export function holds(answer: unknown, question: string): boolean {
  return member(answersOf(answer), question) !== undefined;
}

/** A follow-up's answer: the option chosen, undefined for NONE. */
export function readFollowup(answer: unknown, question: string, options: readonly string[]): string | undefined {
  const { choice, probabilities } = choiceOf(answersOf(answer), question);
  let chosen = choice;
  // The likeliest offered option when the model weighs them (a tie goes to the one offered last); its choice
  // otherwise.
  if (probabilities && Object.keys(probabilities).length > 0 && options.length > 0) {
    chosen = options.reduce((best, option) =>
      weight(probabilities, option) >= weight(probabilities, best) ? option : best,
    );
  }
  if (!options.includes(chosen)) throw notOffered(chosen);
  return chosen === NONE ? undefined : chosen;
}

/** An option and how likely the model found it. */
export type Weighed = readonly [key: string, probability: number];

/**
 * How likely the model found each of some options in its answer to a question (a group of a viewport, or of a
 * dropdown's options), in their order: what a choice past the model's option limit ranks its groups' options by.
 * Throws unless it weighed every one of them (a model that gives only its choice cannot rank).
 */
export function weighed(answer: unknown, question: string, options: readonly string[]): Weighed[] {
  const { probabilities } = choiceOf(answersOf(answer), question);
  if (!probabilities) throw unweighed(question);
  return options.map((option) => {
    const probability = Object.hasOwn(probabilities, option) ? number(probabilities[option]) : undefined;
    if (probability === undefined || !Number.isFinite(probability) || probability < 0) throw unweighed(question);
    return [option, probability];
  });
}

/**
 * The likeliest `most` of every group's options, likeliest first, whichever groups they come from (their
 * probabilities compared as they are, one group free to take every place); a tie goes to the earlier one on the page.
 */
export function likeliest(groups: readonly (readonly Weighed[])[], most: number): string[] {
  return groups
    .flat()
    .sort((a, b) => b[1] - a[1])
    .slice(0, most)
    .map(([key]) => key);
}
