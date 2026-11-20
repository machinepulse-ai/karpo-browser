import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_LIMITS, UNKNOWN_MODEL_LIMITS } from "../../src/decider/models.ts";
import { API_KEY_VARIABLE, MODEL_VARIABLE, profileFor, system1Of, URL_VARIABLE } from "../../src/decider/system1.ts";
import type { DecisionRequest } from "../../src/decider/systemone.ts";
import { OPENROUTER_DECISIONS_URL, SystemOneDecider } from "../../src/decider/systemone.ts";
import { DEFAULT_PROFILE } from "../../src/profile.ts";

const SAVED = { ...process.env };
let server: Server | undefined;
afterEach(() => {
  process.env = { ...SAVED };
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const REQUEST: DecisionRequest = {
  state: { task: { goal: "g" }, values: [], page: { url: "https://a.test/", title: "A", elements: [] } },
  questions: { step: { type: "choice", instructions: "i", criteria: { WAIT: "wait" } } },
};

/** An endpoint that answers WAIT, or never answers; what it was sent is kept. */
async function endpoint(
  answers: boolean,
): Promise<{ url: string; paths: string[]; auth: unknown[]; models: unknown[] }> {
  const seen = { paths: [] as string[], auth: [] as unknown[], models: [] as unknown[] };
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      seen.paths.push(request.url ?? "");
      seen.auth.push(request.headers.authorization);
      seen.models.push(JSON.parse(text).model);
      if (answers) response.end(JSON.stringify({ answers: { step: { choice: "WAIT" } } }));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, ...seen };
}
const ask = (decider: { ask: SystemOneDecider["ask"] }) => decider.ask(REQUEST, { deadline: Date.now() + 10_000 });

describe("System 1 from the options or the environment", () => {
  it("names the variable to set, and the known models, when no model is given", () => {
    delete process.env[MODEL_VARIABLE];
    expect(() => system1Of(undefined)).toThrow(/SYSTEM1_MODEL.*typesafe\/jev-1\.14/s);
  });

  it("takes a reference a launcher did not expand for an unset variable", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the reference as a launcher passes it on, unexpanded
    process.env[MODEL_VARIABLE] = "${SYSTEM1_MODEL}";
    expect(() => system1Of(undefined)).toThrow(/SYSTEM1_MODEL/);
  });

  it("asks OpenRouter's decisions endpoint unless an address is set, with the model's limits", () => {
    delete process.env[URL_VARIABLE];
    process.env[MODEL_VARIABLE] = "google/gemini-decision-1";
    const { decider, limits } = system1Of(undefined);
    expect(decider).toBeInstanceOf(SystemOneDecider);
    expect((decider as unknown as { options: { url: string } }).options.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(limits).toBe(MODEL_LIMITS["google/gemini-decision-1"]);
  });

  it("gives a model the table does not name the cautious limits", () => {
    const { limits } = system1Of({ url: "http://127.0.0.1:1/v1/systemone", model: "my-own" });
    expect(limits).toBe(UNKNOWN_MODEL_LIMITS);
  });

  it("does not take a name the table inherits for one it holds", () => {
    const { limits } = system1Of({ url: "http://127.0.0.1:1/v1/systemone", model: "constructor" });
    expect(limits).toBe(UNKNOWN_MODEL_LIMITS);
  });

  it("leaves a decider given whole as it is, and its requests packed by the default profile", () => {
    const decider = { ask: async () => ({ answers: {} }) };
    expect(system1Of(decider)).toEqual({ decider, limits: undefined });
    expect(profileFor(undefined, undefined)).toBe(DEFAULT_PROFILE);
  });

  it("packs requests to the model's limits, unless a profile is given", () => {
    const limits = MODEL_LIMITS["google/gemini-decision-1"]!;
    const { contextWindow, maxOutputTokens } = profileFor(undefined, limits).decider;
    expect(contextWindow).toBe(262_144);
    expect(maxOutputTokens).toBe(1_024);
    expect(profileFor(undefined, limits).decider).toEqual({
      contextWindow: limits.contextWindow,
      maxOutputTokens: limits.maxOutputTokens,
      maxChoices: limits.maxChoices,
      charsPerToken: limits.charsPerToken,
    });
    const own = { ...DEFAULT_PROFILE, name: "own" };
    expect(profileFor(own, limits)).toBe(own);
  });

  it("gives an attempt the model's time, unless one is given", async () => {
    const url = "http://127.0.0.1:1/v1/systemone";
    const { decider } = system1Of({ url, model: "typesafe/jev-1.14" });
    const timeout = (decider as unknown as { options: { attemptTimeoutMs: number } }).options.attemptTimeoutMs;
    expect(timeout).toBe(MODEL_LIMITS["typesafe/jev-1.14"]!.attemptMs);
    const silent = await endpoint(false);
    const given = system1Of({ url: silent.url, model: "typesafe/jev-1.14", attempts: 1, attemptTimeoutMs: 200 });
    const started = Date.now();
    await expect(ask(given.decider)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reads the address, model and key from the environment; an address in the options gets no environment key", async () => {
    const { url, paths, auth, models } = await endpoint(true);
    process.env[URL_VARIABLE] = `${url}/from/env`;
    process.env[MODEL_VARIABLE] = "env-model";
    process.env[API_KEY_VARIABLE] = "env-key";
    await ask(system1Of(undefined).decider);
    expect([paths[0], auth[0], models[0]]).toEqual(["/from/env", "Bearer env-key", "env-model"]);
    await ask(system1Of({ url: `${url}/given`, model: "given-model" }).decider);
    expect([paths[1], auth[1], models[1]]).toEqual(["/given", undefined, "given-model"]);
    await ask(system1Of({ url: `${url}/given`, model: "given-model", apiKey: "own-key" }).decider);
    expect(auth[2]).toBe("Bearer own-key");
  });
});
