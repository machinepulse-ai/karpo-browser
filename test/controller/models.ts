/**
 * System 2 models the controller is known to work with, by a short name: their OpenRouter ids, the reasoning effort
 * they are run with, and whether they are shown screenshots. Any other model id is run as it is: in words alone, at
 * its own reasoning default.
 */
import type { ChatModel } from "./chat.ts";

export const CONTROLLER_MODELS: Readonly<Record<string, ChatModel>> = {
  "gemini-3.8-flash": { model: "google/gemini-3.8-flash", reasoning: "medium", vision: true },
  "deepseek-v4.1-flash": { model: "deepseek/deepseek-v4.1-flash-1017", reasoning: "high", vision: true },
  /** Thinking is off: it makes a turn many times slower here. */
  "qwen3.8-flash": { model: "qwen/qwen3.8-flash", reasoning: "none", vision: true },
  /** GPT-6 models think whatever they are told: at low effort they answer soonest. */
  "gpt-6.2-sol": { model: "openai/gpt-6.2-sol", reasoning: "low", vision: true },
  "gpt-6.1-sol": { model: "openai/gpt-6.1-sol", reasoning: "low", vision: true },
  "gpt-6-luna": { model: "openai/gpt-6-luna", reasoning: "low", vision: true },
};

/** A model by its preset name, or any model id as it is. */
export function controllerModel(name: string): ChatModel {
  return Object.hasOwn(CONTROLLER_MODELS, name) ? CONTROLLER_MODELS[name]! : { model: name };
}
