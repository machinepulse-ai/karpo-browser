import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { limitsOf } from "../../src/decider/models.ts";
import type { DecisionRequest } from "../../src/decider/systemone.ts";
import {
  addressShown,
  DecisionFailed,
  imagesAsStateItemsFor,
  OPENROUTER_DECISIONS_URL,
  SystemOneDecider,
} from "../../src/decider/systemone.ts";

const REQUEST: DecisionRequest = {
  state: { task: { goal: "g" }, values: [], page: { url: "https://a.test/", title: "A", elements: [] } },
  questions: { step: { type: "choice", instructions: "i", criteria: { WAIT: "wait" } } },
};
/** The path a self-hosted System One endpoint answers at. */
const SYSTEMONE_PATH = "/v1/systemone";
let server: Server | undefined;

/** An endpoint that answers each request with the next of `statuses`; what it was sent, where and how, is kept. */
async function endpoint(
  statuses: number[],
): Promise<{ url: string; bodies: Record<string, unknown>[]; paths: string[]; headers: IncomingHttpHeaders[] }> {
  const bodies: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const headers: IncomingHttpHeaders[] = [];
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      bodies.push(JSON.parse(text));
      paths.push(request.url ?? "");
      headers.push(request.headers);
      response.statusCode = statuses[bodies.length - 1] ?? 200;
      response.end(
        JSON.stringify(response.statusCode === 200 ? { answers: { step: { choice: "WAIT" } } } : { error: "no" }),
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}${SYSTEMONE_PATH}`, bodies, paths, headers };
}

afterEach(() => server?.close());

describe("the System One client", () => {
  it("posts to the address as given, with the key as a bearer token", async () => {
    const { url, paths, headers } = await endpoint([200]);
    await new SystemOneDecider({ url, model: "m", apiKey: "k" }).ask(REQUEST, { deadline: Date.now() + 5_000 });
    expect(paths).toEqual([SYSTEMONE_PATH]);
    expect(headers[0]?.authorization).toBe("Bearer k");
  });

  it("sends the model, the state with the screenshot last, and the questions", async () => {
    const { url, bodies } = await endpoint([200]);
    const decider = new SystemOneDecider({ url, model: "m" });
    await decider.ask(REQUEST, { deadline: Date.now() + 5_000, image: { type: "image_url" } });
    expect(Object.keys(bodies[0]!)).toEqual(["model", "state", "questions"]);
    expect(Object.keys(bodies[0]!.state as object)).toEqual(["task", "values", "page", "viewport_screenshot"]);
  });

  it("sends the screenshot as the second item of a state array when asked to", async () => {
    const { url, bodies } = await endpoint([200]);
    const image = { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } };
    const decider = new SystemOneDecider({ url, model: "m", imagesAsStateItems: true });
    await decider.ask(REQUEST, { deadline: Date.now() + 5_000, image });
    const state = bodies[0]?.state as unknown[];
    expect(Object.keys(bodies[0]!)).toEqual(["model", "state", "questions"]);
    expect(state).toHaveLength(2);
    expect(JSON.parse(state[0] as string)).toEqual(REQUEST.state);
    expect(state[1]).toEqual(image);
  });

  it("sends the state as an object when there is no screenshot, in either form", async () => {
    const { url, bodies } = await endpoint([200]);
    const decider = new SystemOneDecider({ url, model: "m", imagesAsStateItems: true });
    await decider.ask(REQUEST, { deadline: Date.now() + 5_000 });
    expect(bodies[0]?.state).toEqual(REQUEST.state);
  });

  it("reads images as state items for OpenRouter's host and as a state field elsewhere", () => {
    expect(imagesAsStateItemsFor(OPENROUTER_DECISIONS_URL)).toBe(true);
    expect(imagesAsStateItemsFor("http://127.0.0.1:8000/v1/systemone")).toBe(false);
    expect(imagesAsStateItemsFor("not a url")).toBe(false);
  });

  it("tries again what the server could not serve, not what it refused", async () => {
    const busy = await endpoint([503, 200]);
    const answer = await new SystemOneDecider({ url: busy.url, model: "m" }).ask(REQUEST, {
      deadline: Date.now() + 5_000,
    });
    expect([answer, busy.bodies.length]).toEqual([{ answers: { step: { choice: "WAIT" } } }, 2]);
    server?.close();
    const refused = await endpoint([401, 200]);
    const asking = new SystemOneDecider({ url: refused.url, model: "m" }).ask(REQUEST, {
      deadline: Date.now() + 5_000,
    });
    await expect(asking).rejects.toThrow(DecisionFailed);
    expect(refused.bodies.length).toBe(1);
  });

  it("asks nothing past the deadline, and names the address when it cannot be reached", async () => {
    const { url, bodies } = await endpoint([200]);
    await expect(new SystemOneDecider({ url, model: "m" }).ask(REQUEST, { deadline: Date.now() - 1 })).rejects.toThrow(
      /deadline/,
    );
    expect(bodies.length).toBe(0);
    const nowhere = new SystemOneDecider({ url: "http://127.0.0.1:9/v1/systemone", model: "m", attempts: 1 });
    await expect(nowhere.ask(REQUEST, { deadline: Date.now() + 5_000 })).rejects.toThrow(/127\.0\.0\.1:9/);
  });

  it("quotes an address without its user-info, query string or fragment", async () => {
    for (const url of ["http://user:pass@127.0.0.1:9/v1/systemone?key=secret#x", "http://user:pass@[bad/?key=secret"]) {
      const lost = new SystemOneDecider({ url, model: "m", attempts: 1 }).ask(REQUEST, {
        deadline: Date.now() + 5_000,
      });
      const error = await lost.then(
        () => undefined,
        (failure: Error) => failure,
      );
      expect(error).toBeInstanceOf(DecisionFailed);
      expect(error?.message).not.toMatch(/pass|secret/);
    }
    expect(addressShown("http://user:pass@127.0.0.1:9/v1/systemone?key=secret")).toBe(
      "http://127.0.0.1:9/v1/systemone",
    );
  });

  it("gives an attempt the model's time when none is given", async () => {
    const { url } = await endpoint([200]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const model = "typesafe/jev-1.14";
    await new SystemOneDecider({ url, model }).ask(REQUEST, { deadline: Date.now() + 60_000 });
    expect(timeout).toHaveBeenCalledWith(limitsOf(model).attemptMs);
    timeout.mockRestore();
  });
});
