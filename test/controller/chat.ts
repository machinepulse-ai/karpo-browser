/**
 * A general language model asked turn by turn with tools, over the chat completions interface most providers speak
 * (OpenAI's, and the gateways that follow it, OpenRouter among them): each turn it answers in words, with tool calls,
 * or both. Its message goes back into the history as the provider gave it, so what a model carries between turns
 * (OpenRouter's `reasoning_details`, which Gemini's thought signatures ride in; Vertex AI's `extra_content`) stays
 * with it.
 */

/** The variables that name System 2's endpoint and its key. */
const BASE_URL_VARIABLE = "SYSTEM2_BASE_URL";
const API_KEY_VARIABLE = "SYSTEM2_API_KEY";
/** OpenRouter's chat completions endpoint, where the presets' model names are. */
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const CHAT_PATH = "chat/completions";
/** How long one turn may take: a reasoning model may think for a while before it answers. */
const TURN_TIMEOUT_MS = 180_000;
/** How often a turn lost on the way (the network, 429, a 5xx) is asked, and how long the first wait is (doubling). */
const TURN_ATTEMPTS = 3;
const RETRY_WAIT_MS = 2_000;
/** Answers that are worth asking again: too many requests, and the server's own failures. */
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
/** How much of a refusal's body its error quotes. */
const REFUSAL_CHARS = 300;
/** The fields of an assistant message that go back into the history. */
const KEPT_FIELDS = ["role", "content", "tool_calls", "reasoning_details", "extra_content"] as const;

/** A model a turn is asked of. */
export interface ChatModel {
  /** The provider's base address; else SYSTEM2_BASE_URL, else OpenRouter's. */
  baseUrl?: string | undefined;
  /** Else SYSTEM2_API_KEY. */
  apiKey?: string | undefined;
  model: string;
  /** Whether the turn must call one of the tools offered (`required`) or may answer in words (`auto`, the default). */
  toolChoice?: "auto" | "required" | undefined;
  /**
   * How hard it thinks before it answers, as OpenRouter's `reasoning.effort`; `none` turns thinking off
   * (`reasoning.enabled: false`, for models that think by default); left out, the model's own default.
   */
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | undefined;
  /** OpenRouter's provider routing (`provider`: which providers serve the model, and whether others may), as given. */
  provider?: Readonly<Record<string, unknown>> | undefined;
  /** Whether it reads images: the page's screenshot is shown to it after an action. */
  vision?: boolean | undefined;
}

/** A tool the model may call: its name, what it does, and its arguments' JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
}

/** A tool call as the model made it: its arguments are JSON text, unchecked. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Tokens a turn took, as the provider counted them. */
export interface Usage {
  input: number;
  /** The output tokens billed: the reasoning ones among them, whether or not the provider counts them apart. */
  output: number;
  /** Input tokens the provider served from its cache (billed at its lower rate), when it says. */
  cached?: number;
}

/**
 * A chat completions answer's usage as billed. OpenAI and OpenRouter count reasoning tokens inside completion_tokens;
 * Vertex AI counts them apart (completion_tokens_details.reasoning_tokens) and in total_tokens. Output is therefore
 * what total_tokens holds past the prompt when that is more than completion_tokens.
 */
export function chatUsage(usage: Record<string, unknown> | undefined): Usage {
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  const input = count(usage?.prompt_tokens);
  const completion = count(usage?.completion_tokens);
  const total = count(usage?.total_tokens);
  const output = total > input + completion ? total - input : completion;
  const details = usage?.prompt_tokens_details;
  const cached =
    typeof details === "object" && details !== null ? (details as Record<string, unknown>).cached_tokens : undefined;
  return { input, output, ...(typeof cached === "number" ? { cached } : {}) };
}

/** One turn's answer: the message as it goes back into the history, its words and its tool calls. */
export interface Turn {
  message: Record<string, unknown>;
  text: string;
  calls: ToolCall[];
  usage: Usage;
}

/** No turn could be had: refused, or lost on every attempt. */
export class ChatFailed extends Error {}

/** Asks one turn of a model, given the conversation so far and the tools it may call. */
export type AskTurn = (
  model: ChatModel,
  messages: readonly unknown[],
  tools: readonly ToolSpec[],
  signal?: AbortSignal,
) => Promise<Turn>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A message's words: its content as text, or the text parts of a content list. */
function wordsOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => record(part))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text as string)
    .join("\n");
}

function callsOf(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((raw) => {
    const call = record(raw);
    const fn = record(call?.function);
    if (typeof call?.id !== "string" || typeof fn?.name !== "string") return [];
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    return [{ id: call.id, name: fn.name, arguments: args }];
  });
}

/** The turn read from a provider's answer. */
export function turnOf(answer: unknown): Turn {
  const choices = record(answer)?.choices;
  const said = record(record(Array.isArray(choices) ? choices[0] : undefined)?.message);
  if (!said) throw new ChatFailed("the answer holds no message");
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) if (said[field] !== undefined) kept[field] = said[field];
  kept.role = "assistant";
  if (kept.content === undefined) kept.content = null;
  const usage = record(record(answer)?.usage);
  return {
    message: kept,
    text: wordsOf(said.content),
    calls: callsOf(said.tool_calls),
    usage: chatUsage(usage),
  };
}

/** Waits `ms`, or until a stop from outside. */
export function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Asks one turn over HTTP; `fetchImpl` stands in for `fetch` in tests. */
export function httpTurns(fetchImpl: typeof fetch = fetch): AskTurn {
  return async (model, messages, tools, signal) => {
    const baseUrl = (model.baseUrl || process.env[BASE_URL_VARIABLE] || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const apiKey = model.apiKey ?? process.env[API_KEY_VARIABLE];
    const body = JSON.stringify({
      model: model.model,
      messages,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: model.toolChoice ?? "auto",
          }
        : {}),
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.reasoning === "none"
        ? { reasoning: { enabled: false } }
        : model.reasoning
          ? { reasoning: { effort: model.reasoning } }
          : {}),
    });
    let last = "";
    for (let attempt = 1; attempt <= TURN_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(TURN_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${baseUrl}/${CHAT_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await response.text();
        if (response.ok) return turnOf(JSON.parse(text));
        last = `status ${response.status}: ${text.slice(0, REFUSAL_CHARS)}`;
        if (response.status !== TOO_MANY_REQUESTS && response.status < SERVER_ERROR) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ChatFailed) throw error;
        last = error instanceof Error ? error.message : String(error);
      }
      if (attempt < TURN_ATTEMPTS) await pause(RETRY_WAIT_MS * 2 ** (attempt - 1), signal);
    }
    throw new ChatFailed(`${model.model}: ${last}`);
  };
}
