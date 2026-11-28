import { describe, expect, it } from "vitest";
import { ChatFailed, httpTurns, turnOf } from "./chat.ts";

const ANSWER = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        reasoning_details: [{ type: "reasoning.encrypted", data: "sig" }],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_page", arguments: "{}" } }],
        refusal: null,
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 8 },
};

describe("chat", () => {
  it("reads tool calls and keeps what the model carries between turns", () => {
    const turn = turnOf(ANSWER);
    expect(turn.calls).toEqual([{ id: "call_1", name: "read_page", arguments: "{}" }]);
    expect(turn.message).toEqual({
      role: "assistant",
      content: null,
      reasoning_details: [{ type: "reasoning.encrypted", data: "sig" }],
      tool_calls: ANSWER.choices[0]!.message.tool_calls,
    });
    expect(turn.usage).toEqual({ input: 120, output: 8 });
  });

  it("asks with the tools and the reasoning effort, again after a server failure", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      calls++;
      return calls === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(ANSWER));
    }) as unknown as typeof fetch;
    const tools = [{ name: "read_page", description: "Reads.", parameters: { type: "object", properties: {} } }];
    const turn = await httpTurns(fake)(
      { model: "m", baseUrl: "https://x.test/v1", reasoning: "high" },
      [{ role: "user", content: "hi" }],
      tools,
    );
    expect(calls).toBe(2);
    expect(turn.calls[0]?.name).toBe("read_page");
    expect(bodies[0]).toMatchObject({
      model: "m",
      reasoning: { effort: "high" },
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "read_page" } }],
    });
  });

  it("turns thinking off with reasoning none", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(ANSWER));
    }) as unknown as typeof fetch;
    await httpTurns(fake)({ model: "m", baseUrl: "https://x.test/v1", reasoning: "none" }, [], []);
    expect(bodies[0]?.reasoning).toEqual({ enabled: false });
  });

  it("passes the provider routing as given", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(ANSWER));
    }) as unknown as typeof fetch;
    const provider = { only: ["some-provider"], allow_fallbacks: false };
    await httpTurns(fake)({ model: "m", baseUrl: "https://x.test/v1", provider }, [], []);
    await httpTurns(fake)({ model: "m", baseUrl: "https://x.test/v1" }, [], []);
    expect(bodies[0]?.provider).toEqual(provider);
    expect(bodies[1]).not.toHaveProperty("provider");
  });

  it("does not ask again after a refusal", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(httpTurns(fake)({ model: "m", baseUrl: "https://x.test/v1" }, [], [])).rejects.toBeInstanceOf(
      ChatFailed,
    );
    expect(calls).toBe(1);
  });

  it("stops retrying if the task runs out of time while reading a transient error", async () => {
    const stop = new AbortController();
    const reason = new Error("answer due");
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      stop.abort(reason);
      return new Response("busy", { status: 503 });
    };
    await expect(httpTurns(fetchImpl)({ model: "m" }, [], [], stop.signal)).rejects.toBe(reason);
    expect(calls).toBe(1);
  });
});
