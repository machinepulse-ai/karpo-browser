/**
 * Asking a decision model (System 1) over the System One protocol: one request (the state and the questions), one
 * answer (`{"answers": {question: …}}`), over HTTP. OpenRouter serves hosted decision models at
 * OPENROUTER_DECISIONS_URL; a model served on your own machines answers at its own address (for example
 * http://host:port/v1/systemone). An attempt the network lost or the server could not serve is made again; one the
 * server refused is not.
 */

import { limitsOf } from "./models.ts";
import { SCREENSHOT_FIELD } from "./screenshot.ts";

/** Where OpenRouter serves hosted decision models. */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** The host whose decisions endpoint reads an image only as an item of a top-level state array. */
const OPENROUTER_HOST = "openrouter.ai";
const DEFAULT_ATTEMPTS = 2;
/** How long a lost attempt waits before the next, doubling up to the longest. */
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;
const TOO_MANY_REQUESTS = 429;
/** How much of a refusal's body its error quotes. */
const REFUSAL_CHARS = 300;

/** A value of the task: typed by its number; a secret's text is never sent. */
export type SystemOneValue = { n: number; name: string; text: string } | { n: number; name: string; secret: true };

/** What the questions are about: the task, its values, the run so far, the recent actions and the page. */
export interface SystemOneState {
  task: { goal: string };
  values: SystemOneValue[];
  /** The run's summary, when the reading gives it. */
  run?: unknown;
  /** The recent actions, oldest first, one a line. */
  recent_actions?: string;
  page: { url: string; title: string; elements: readonly string[] };
  /** The viewport's screenshot, as an `image_url` part, when the step carries one. */
  [SCREENSHOT_FIELD]?: object;
}

/** A question answered by choosing one of its options (`criteria`, keyed by the answer each is). */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** A question answered with a number from 0 to 1. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export type SystemOneQuestion = ChoiceQuestion | NoulQuestion;
/** The questions of a request, by name: `step` and `looping`, or a follow-up (`value`, `option`, `value 7`). */
export type SystemOneQuestions = Record<string, SystemOneQuestion>;

/** A state with a screenshot as OpenRouter reads it: the rest of the state as compact JSON text, then the image. */
export type SystemOneStateItems = [state: string, image: object];

/** A decision request as it is posted. */
export interface SystemOneRequest {
  model: string;
  state: SystemOneState | SystemOneStateItems;
  questions: SystemOneQuestions;
}

/** A choice question's answer: the option chosen, and every option's probability when the model gives them. */
export interface ChoiceAnswer {
  choice: string;
  probabilities?: Record<string, number>;
  /**
   * What the model saw when it ended or reached the goal: the step question asks for it, and a DONE run reports it
   * as its detail.
   */
  note?: string;
}

/** A number question's answer. */
export interface NoulAnswer {
  noul: number;
}

/** A decision model's answer: each question's, by its name. */
export interface SystemOneAnswer {
  answers: Record<string, ChoiceAnswer | NoulAnswer>;
}

/** A decision request: the state the questions are about, and the questions. */
export interface DecisionRequest {
  state: SystemOneState;
  questions: SystemOneQuestions;
}

/** What a request is asked with besides itself. */
export interface AskContext {
  /** The step's screenshot (an `image_url` part), put into the request's state. */
  image?: object | undefined;
  /** The moment (epoch ms) past which no answer is waited for. */
  deadline: number;
  /** Stops the asking from outside. */
  signal?: AbortSignal | undefined;
}

/** What answers decision requests. */
export interface Decider {
  ask(request: DecisionRequest, context: AskContext): Promise<SystemOneAnswer>;
}

/** No attempt got an answer that can be read. */
export class DecisionFailed extends Error {}

export interface SystemOneOptions {
  /** The System One endpoint's whole address; requests are posted to it as it is. */
  url: string;
  /** The model's name at the endpoint. */
  model: string;
  /** Sent as `Authorization: Bearer <key>`. */
  apiKey?: string | undefined;
  /** How many times a request is tried, and how long one try may take (the model's own, by `limitsOf`, when left out). */
  attempts?: number | undefined;
  attemptTimeoutMs?: number | undefined;
  /**
   * Whether a screenshot goes as the second item of a top-level state array whose first item is the rest of the state
   * as compact JSON text (how OpenRouter's decisions endpoint reads images), instead of in `state.viewport_screenshot`
   * (how self-hosted servers read it). Left out: the array form for an address on OpenRouter's host, the object form
   * otherwise.
   */
  imagesAsStateItems?: boolean | undefined;
}

/** Whether the endpoint at `url` reads images as state items: OpenRouter's host does, an unparsable address not. */
export function imagesAsStateItemsFor(url: string): boolean {
  try {
    return new URL(url).hostname === OPENROUTER_HOST;
  } catch {
    return false;
  }
}

/** An address without what may hold a secret: user-info, query string and fragment. */
export function addressShown(url: string): string {
  try {
    const { protocol, host, pathname } = new URL(url);
    return `${protocol}//${host}${pathname}`;
  } catch {
    return "the endpoint";
  }
}

/** What an error says, with what caused it (a failed fetch names only its cause). */
function saidBy(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** Waits `ms`, or until a stop from outside. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(ms, 0));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A decision model behind a System One endpoint. */
export class SystemOneDecider implements Decider {
  private readonly options: SystemOneOptions;
  private readonly imagesAsStateItems: boolean;

  constructor(options: SystemOneOptions) {
    this.options = options;
    this.imagesAsStateItems = options.imagesAsStateItems ?? imagesAsStateItemsFor(options.url);
  }

  async ask(request: DecisionRequest, context: AskContext): Promise<SystemOneAnswer> {
    let state: SystemOneRequest["state"] = request.state;
    if (context.image) {
      state = this.imagesAsStateItems
        ? [JSON.stringify(request.state), context.image]
        : { ...request.state, [SCREENSHOT_FIELD]: context.image };
    }
    const sent: SystemOneRequest = { model: this.options.model, state, questions: request.questions };
    const body = JSON.stringify(sent);
    const tries = this.options.attempts ?? DEFAULT_ATTEMPTS;
    let reason = "the deadline passed";
    let wait = FIRST_RETRY_MS;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const left = context.deadline - Date.now();
      if (left <= 0) break;
      const timeout = AbortSignal.timeout(
        Math.min(left, this.options.attemptTimeoutMs ?? limitsOf(this.options.model).attemptMs),
      );
      const outcome = await this.post(body, context.signal ? AbortSignal.any([context.signal, timeout]) : timeout);
      if ("answer" in outcome) return outcome.answer;
      reason = outcome.reason;
      if (!outcome.lost || context.signal?.aborted) break;
      if (attempt + 1 < tries) await pause(Math.min(wait, context.deadline - Date.now()), context.signal);
      wait = Math.min(wait * 2, MAX_RETRY_MS);
    }
    // An error may quote the address as it was given: what it says is cleaned of what may hold a key.
    const shown = addressShown(this.options.url);
    throw new DecisionFailed(`${shown}: ${reason.replaceAll(this.options.url, shown)}`);
  }

  /** One attempt: the answer, or why there is none and whether another attempt may get one. */
  private async post(
    body: string,
    signal: AbortSignal,
  ): Promise<{ answer: SystemOneAnswer } | { reason: string; lost: boolean }> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body,
        signal,
      });
      text = await response.text();
    } catch (error) {
      return { reason: saidBy(error), lost: true };
    }
    if (response.status === TOO_MANY_REQUESTS || response.status >= 500) {
      return { reason: `status ${response.status}`, lost: true };
    }
    if (!response.ok) return { reason: `status ${response.status}: ${text.slice(0, REFUSAL_CHARS)}`, lost: false };
    try {
      const answer: unknown = JSON.parse(text);
      const answers =
        typeof answer === "object" && answer !== null ? (answer as { answers?: unknown }).answers : undefined;
      if (typeof answers === "object" && answers !== null) return { answer: answer as SystemOneAnswer };
      return { reason: "the answer holds no answers", lost: false };
    } catch {
      return { reason: "the answer is not JSON", lost: false };
    }
  }
}
