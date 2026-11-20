import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_CHROME } from "./support.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
/** How long the decisions endpoint takes to answer: long enough for a ping and a cancellation to arrive meanwhile. */
const DECISION_DELAY_MS = 5_000;
/** How long after the call the cancellation is sent: the page is read by then and the decision asked for. */
const CANCEL_AFTER_MS = 2_000;

const PAGE =
  "<!doctype html><title>Page</title><button>Go</button><input aria-label='Name'>" +
  "<select aria-label='Size'><option>Small</option><option>Large</option></select>";

/** A site with one page and a decisions endpoint that answers WAIT, slowly. */
function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.setHeader("content-type", "text/html").end(PAGE);
      return;
    }
    request.resume();
    const answers = { step: { choice: "WAIT", probabilities: { WAIT: 0.9 } }, looping: { noul: 0 } };
    setTimeout(
      () => response.setHeader("content-type", "application/json").end(JSON.stringify({ answers })),
      DECISION_DELAY_MS,
    );
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Message = { id?: unknown; method?: string; result?: Record<string, unknown>; error?: { code: number } };

/** The MCP server as a child process on stdin and stdout: what is sent, and the answer to a request by its id. */
function client(env: Record<string, string>) {
  const child = spawn(process.execPath, [CLI, "mcp"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const received: Message[] = [];
  let waiting: (() => void) | undefined;
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line) received.push(JSON.parse(line));
    waiting?.();
  });
  const send = (message: object | string) =>
    child.stdin.write(`${typeof message === "string" ? message : JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const answerTo = async (id: unknown) => {
    for (;;) {
      const found = received.find((message) => message.id === id && message.method === undefined);
      if (found) return found;
      await new Promise<void>((resolve) => {
        waiting = resolve;
      });
    }
  };
  const stop = async () => {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  };
  return { received, send, answerTo, stop };
}

/** What a tool call's result says, as text. */
const textOf = (message: Message) => ((message.result?.content ?? []) as { text: string }[])[0]?.text ?? "";

const TOOL_NAMES = [
  "open",
  "run_browser_agent",
  "read_page",
  "click",
  "type",
  "select",
  "press_enter",
  "escape",
  "scroll",
  "back",
  "screenshot",
];

describe("the tools over the Model Context Protocol, without a browser", () => {
  it("answers initialize and tools/list, and refuses what it cannot read before any browser starts", async () => {
    const { send, answerTo, stop } = client({ SYSTEM1_MODEL: "scripted" });
    try {
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
      const initialized = (await answerTo(1)).result ?? {};
      expect(initialized.protocolVersion).toBe("2025-06-18");
      expect(String(initialized.instructions)).toMatch(/run_browser_agent/);
      expect((initialized.serverInfo as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
      send({ id: 2, method: "tools/list" });
      const names = (((await answerTo(2)).result?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
      expect(names).toEqual(TOOL_NAMES);
      send("this is not JSON");
      expect((await answerTo(null)).error?.code).toBe(-32700);
      const refused = [
        ["no_such_tool", {}],
        ["click", { element: "x" }],
        ["scroll", { direction: "left" }],
        ["open", { url: "file:///etc/hosts" }],
      ] as const;
      for (const [index, [name, args]] of refused.entries()) {
        send({ id: 10 + index, method: "tools/call", params: { name, arguments: args } });
        expect((await answerTo(10 + index)).error?.code).toBe(-32602);
      }
    } finally {
      await stop();
    }
  }, 30_000);
});

describe.skipIf(!HAS_CHROME)("the tools over the Model Context Protocol", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = await serve();
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("answers while a tool works, stops a cancelled call, and refuses what it cannot read", async () => {
    const { received, send, answerTo, stop } = client({
      BROWSER_HEADLESS: "1",
      SYSTEM1_URL: `${url}/v1/systemone`,
      SYSTEM1_MODEL: "scripted",
    });
    try {
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
      await answerTo(1);
      send({ id: 3, method: "tools/call", params: { name: "open", arguments: { url } } });
      expect((await answerTo(3)).result?.isError).toBeUndefined();
      send({ id: 11, method: "tools/call", params: { name: "read_page", arguments: {} } });
      const page = textOf(await answerTo(11));
      const number = (words: string) => Number(new RegExp(`(\\d+) ${words}`).exec(page)?.[1]);
      send({
        id: 12,
        method: "tools/call",
        params: { name: "type", arguments: { element: number("textbox Name"), text: "Ann" } },
      });
      expect((await answerTo(12)).result?.isError).toBeUndefined();
      send({
        id: 13,
        method: "tools/call",
        params: { name: "select", arguments: { element: number("select Size"), option: "Large" } },
      });
      expect((((await answerTo(13)).result?.content ?? []) as { text: string }[])[0]?.text).toMatch(/done/);
      send({ id: 15, method: "tools/call", params: { name: "screenshot", arguments: {} } });
      const shot = (((await answerTo(15)).result?.content ?? []) as { type: string; mimeType?: string }[])[0];
      expect([shot?.type, shot?.mimeType]).toEqual(["image", "image/jpeg"]);
      send({ id: 16, method: "tools/call", params: { name: "scroll", arguments: { direction: "down" } } });
      expect((await answerTo(16)).result?.isError).toBeUndefined();
      // The other hand actions answer too: a click on a button, Enter, Escape, typing with Enter, and back.
      send({ id: 17, method: "tools/call", params: { name: "read_page", arguments: {} } });
      const again = textOf(await answerTo(17));
      const numberAgain = (words: string) => Number(new RegExp(`(\\d+) ${words}`).exec(again)?.[1]);
      const hand = [
        ["click", { element: numberAgain("button Go") }],
        ["press_enter", { element: numberAgain("textbox Name") }],
        ["escape", {}],
        ["type", { element: numberAgain("textbox Name"), text: "Bo", enter: true }],
        ["open", { url: `${url}/two` }],
        ["back", {}],
      ] as const;
      for (const [index, [name, args]] of hand.entries()) {
        send({ id: 30 + index, method: "tools/call", params: { name, arguments: args } });
        expect(await answerTo(30 + index), name).toMatchObject({
          result: expect.not.objectContaining({ isError: true }),
        });
      }
      // A goal may hold a line separator: a message ends with a line feed alone.
      const goal = "Wait\u2028for the page";
      send({ id: 4, method: "tools/call", params: { name: "run_browser_agent", arguments: { goal } } });
      send({ id: 5, method: "ping" });
      await answerTo(5);
      expect(received.some((message) => message.id === 4)).toBe(false);
      // Cancelled while the decision is being asked for: the run ends as stopped, not as failed.
      await new Promise((resolve) => setTimeout(resolve, CANCEL_AFTER_MS));
      send({ method: "notifications/cancelled", params: { requestId: 4 } });
      const stopped = (await answerTo(4)).result ?? {};
      expect((stopped.content as { text: string }[])[0]?.text).toMatch(/^interrupted/);
      expect(stopped.isError).toBeUndefined();
    } finally {
      await stop();
    }
  }, 60_000);
});
