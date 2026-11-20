/**
 * The agent Stagehand's eval harness runs for each task of a benchmark (the `karpo_browser` harness stagehand.patch
 * adds): karpo-browser's controller as System 2 and a decision model as System 1, in the configuration of our published
 * runs (test/controller/benchmark.ts), except that System 2's provider is left to OpenRouter: ours was served by a
 * single provider, and with another, speed and cost differ.
 *
 * It speaks the protocol of the harness's Deep Agents runner: one JSON object on stdin (the task, the facade's MCP
 * server, the tool-call budget, the run's time, where to keep records); one JSON event a line on stdout (assistant,
 * tool_call, tool_result, error, final, usage), each with `ts`; the report as `EVAL_RESULT: {"success", "summary",
 * "finalAnswer"}`, or as that JSON alone when the input gives a result schema.
 *
 * The browser is the task's own Browserbase session, over a CDP connection of the agent's own (Browserbase takes it
 * next to Stagehand's), found by the session id the harness gives in BROWSERBASE_SESSION_ID: the facade tells agents
 * nothing of its session. The facade is called once, at the start, as the harness captures its evidence (the page's
 * screenshot, address and accessibility tree) only once it has seen a tool call of the agent's. Each step of System 1,
 * and each call of System 2's that reads or acts on the page, is then told as a tool call on the facade's server name:
 * the harness records the page after it as it does after a facade call, and the call counts against the tool-call
 * budget, which the agent keeps. So are the start page as System 2 read it and the pages System 1 judged done, with
 * their screenshots, which the judge would otherwise lack (events.ts).
 *
 * agent.sh starts it, with no arguments: node evals/stagehand/agent.ts < input.json
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { profileFor } from "../../src/decider/system1.ts";
import type { AskContext, Decider, DecisionRequest, SystemOneAnswer } from "../../src/index.ts";
import { Browser, system1Of } from "../../src/index.ts";
import {
  BENCHMARK_MODEL,
  BENCHMARK_SYSTEM1,
  benchmarkBrowserOptions,
  benchmarkControlOptions,
} from "../../test/controller/benchmark.ts";
import { controllerBrowser } from "../../test/controller/browser.ts";
import { control } from "../../test/controller/controller.ts";
import { controllerModel } from "../../test/controller/models.ts";
import type { ProtocolEvent, Told } from "./events.ts";
import {
  assistant,
  BROWSERBASE_KEY_VARIABLE,
  BUDGET_RESERVE,
  browserActionsFor,
  cut,
  SYSTEM2_KEY_VARIABLE,
  scrub,
  secretsOf,
  TEXT_MOST,
  Teller,
} from "./events.ts";

/** The variables the harness and the person running it set (the keys' are in events.ts, which hides them). */
const SESSION_VARIABLE = "BROWSERBASE_SESSION_ID";
const SYSTEM1_MODEL_VARIABLE = "SYSTEM1_MODEL";
const SYSTEM2_MODEL_VARIABLE = "SYSTEM2_MODEL";
const SYSTEM2_BASE_URL_VARIABLE = "SYSTEM2_BASE_URL";
/** The addresses of a server on this machine, which may answer System 2's turns without a key. */
const LOCAL_ADDRESSES = ["http://127.0.0.1", "http://localhost"];
/** Browserbase's CDP endpoint. The key and the session go in its query, so the whole address is never said. */
const CONNECT_URL = "wss://connect.browserbase.com";
/** The facade relay's variable for its bridge's port, in the server spec the input gives; the bridge is local. */
const BRIDGE_PORT_VARIABLE = "STAGEHAND_EVALS_FACADE_BRIDGE_PORT";
const BRIDGE_HOST = "127.0.0.1";
/** What the facade is told of the protocol and of its client. */
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT = { name: "karpo-browser", version: "1" };
/** The facade call that lets the harness capture evidence: its own `run`, of code that changes nothing. */
const FIRST_FACADE_TOOL = "run";
const FIRST_FACADE_CODE = "return page.url();";
const FACADE_CALL_TIMEOUT_MS = 60_000;
/** The protocol's words. */
const REPORT = "EVAL_RESULT: ";
const TOOL_STEP_BUDGET_KIND = "tool_step_budget";
const EXCEPTION_KIND = "exception";
const CONFIG_KIND = "config";
/** The exit codes: a failure of the program itself, and an input or a setting it cannot work with. */
const FAILED_EXIT = 1;
const REFUSED_EXIT = 2;
/** The run's time and its tool calls when the input does not give them: the harness's own defaults. */
const DEFAULT_RUN_SECONDS = 2_400;
const DEFAULT_TOOL_STEPS = 100;
/** Time kept back from `run_seconds` for the report and the harness's last capture. */
const REPORT_MARGIN_MS = 45_000;
/** The least time a task is given, whatever `run_seconds` says. */
const LEAST_RUN_MS = 60_000;
const MS_PER_S = 1_000;
/** Why a task was stopped from inside: its time, or its budget. */
const TIME_STOP = "time";
const BUDGET_STOP = "budget";
/** The most characters told of a failure's reason in the report's summary. */
const REASON_MOST = 500;
/** The execution record, in the input's `records_dir`, and the indent it is written with. */
const RECORD_FILE = "karpo-browser-run.json";
const RECORD_INDENT = 1;
/**
 * The task as the harness's prompt words it, when the input does not give it apart: the start page, the instruction.
 */
const START_LINE = /^Start URL:\s*(\S+)/m;
const INSTRUCTION_HEADING = /^Instruction:\s*$/m;
const INSTRUCTION_LINE = /^Instruction:\s*(.+)$/m;

interface ServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Input {
  prompt?: string;
  system_prompt?: string | null;
  mcp_servers?: Record<string, ServerSpec>;
  recursion_limit?: number | null;
  max_tool_steps?: number | null;
  result_schema?: unknown;
  instruction?: string | null;
  start_url?: string | null;
  run_seconds?: number | null;
  records_dir?: string | null;
}

/** The report, as the harness reads it. */
interface Report {
  success: boolean;
  summary: string;
  finalAnswer: string | null;
}

/** What is hidden wherever the program speaks or records: the keys it may know of, and System 1's address. */
const secrets = secretsOf(process.env);
const hidden = (text: string): string => scrub(text, secrets);
const say = (event: ProtocolEvent): void => {
  process.stdout.write(`${hidden(JSON.stringify({ ...event, ts: Date.now() / MS_PER_S }))}\n`);
};
const log = (message: string): void => {
  process.stderr.write(`${CLIENT.name}: ${hidden(message)}\n`);
};

/** Says why the task cannot be worked as given, as the protocol's config error. */
function refuse(message: string): number {
  say({ type: "error", kind: CONFIG_KIND, message });
  return REFUSED_EXIT;
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The task: the input's `instruction` and `start_url`, else read from the prompt as the harness words it. */
function taskOf(input: Input): { start: string; goal: string } | undefined {
  if (input.instruction && input.start_url) return { start: input.start_url, goal: input.instruction };
  const prompt = input.prompt ?? "";
  const start = prompt.match(START_LINE)?.[1];
  const goal = prompt.split(INSTRUCTION_HEADING)[1]?.trim() || prompt.match(INSTRUCTION_LINE)?.[1];
  return start && goal ? { start, goal } : undefined;
}

/** What the controller is given to work: the task, and what the harness's system prompt adds to it. */
function taskText(goal: string, systemPrompt: string | null | undefined): string {
  const adds = systemPrompt?.trim();
  return adds ? `${goal}\n\n(The one who set this task adds: ${adds})` : goal;
}

/** The facade through its bridge: newline-delimited JSON-RPC (MCP) over the bridge's port on this machine. */
class Facade {
  private readonly socket: net.Socket;
  private next = 1;
  private buffered = "";
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    // Decoded as a stream, so that a character split between two chunks comes out whole.
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffered += chunk;
      let end = this.buffered.indexOf("\n");
      while (end >= 0) {
        const line = this.buffered.slice(0, end).trim();
        this.buffered = this.buffered.slice(end + 1);
        end = this.buffered.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const answer = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
          if (answer) {
            this.waiting.delete(message.id as number);
            answer(message);
          }
        } catch {
          // A line that is not JSON answers nothing of ours.
        }
      }
    });
    socket.on("error", () => undefined);
  }

  static connect(port: number): Promise<Facade> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: BRIDGE_HOST, port });
      socket.once("connect", () => resolve(new Facade(socket)));
      socket.once("error", reject);
    });
  }

  request(method: string, params: object): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`facade ${method} timed out`));
      }, FACADE_CALL_TIMEOUT_MS);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    this.socket.end();
  }
}

/**
 * System 1 as the library builds it from the SYSTEM1_* variables, its decisions counted for the record: how many
 * answered and failed, how long each took, how big each request was and its screenshot's share of it (for the decision
 * model's cost), and what the server said it used, when it says.
 */
class CountedDecider implements Decider {
  private readonly inner: Decider;
  calls = 0;
  failures = 0;
  readonly ms: number[] = [];
  readonly bytes: number[] = [];
  readonly imageBytes: number[] = [];
  readonly usage: unknown[] = [];

  constructor(inner: Decider) {
    this.inner = inner;
  }

  async ask(request: DecisionRequest, context: AskContext): Promise<SystemOneAnswer> {
    const image = context.image ? JSON.stringify(context.image).length : 0;
    const size = JSON.stringify({ state: request.state, questions: request.questions }).length + image;
    const began = Date.now();
    try {
      const answer = await this.inner.ask(request, context);
      this.calls++;
      this.ms.push(Date.now() - began);
      this.bytes.push(size);
      this.imageBytes.push(image);
      const usage = (answer as { usage?: unknown }).usage;
      if (usage !== undefined) this.usage.push(usage);
      return answer;
    } catch (error) {
      if (!context.signal?.aborted) this.failures++;
      throw error;
    }
  }
}

async function main(): Promise<number> {
  let input: Input;
  try {
    input = JSON.parse(await readInput()) as Input;
  } catch (error) {
    return refuse(`input is not JSON: ${(error as Error).message}`);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return refuse("input is not a JSON object");
  const servers = Object.entries(input.mcp_servers ?? {});
  const [server] = servers;
  const port = Number(server?.[1]?.env?.[BRIDGE_PORT_VARIABLE]);
  if (!server || servers.length !== 1 || !Number.isInteger(port)) {
    return refuse("the input must name one MCP server: the facade's relay, with its bridge's port");
  }
  const task = taskOf(input);
  if (!task) return refuse("no task: neither instruction and start_url nor a prompt with Start URL and Instruction");
  const sessionId = process.env[SESSION_VARIABLE]?.trim();
  if (!sessionId) return refuse(`${SESSION_VARIABLE} is not set: the harness gives it with a Browserbase session`);
  const key = process.env[BROWSERBASE_KEY_VARIABLE]?.trim();
  if (!key) return refuse(`${BROWSERBASE_KEY_VARIABLE} is not set`);
  // System 2's key and System 1's settings are checked before anything is connected to, as the controller's command
  // line checks them: System 1's (the library reads them) throw, naming the variable that is missing.
  const system2BaseUrl = process.env[SYSTEM2_BASE_URL_VARIABLE]?.trim() ?? "";
  if (
    !process.env[SYSTEM2_KEY_VARIABLE]?.trim() &&
    !LOCAL_ADDRESSES.some((local) => system2BaseUrl.startsWith(local))
  ) {
    return refuse(
      `no System 2 key: set ${SYSTEM2_KEY_VARIABLE}, or ${SYSTEM2_BASE_URL_VARIABLE} to a server on this machine`,
    );
  }
  let system1: ReturnType<typeof system1Of>;
  try {
    system1 = system1Of(BENCHMARK_SYSTEM1);
  } catch (error) {
    return refuse((error as Error).message);
  }
  const system2Model = process.env[SYSTEM2_MODEL_VARIABLE]?.trim();
  const model = system2Model ? controllerModel(system2Model) : BENCHMARK_MODEL;
  const decider = new CountedDecider(system1.decider);
  const serverName = server[0];
  const { start, goal } = task;
  const budget = input.max_tool_steps ?? input.recursion_limit ?? DEFAULT_TOOL_STEPS;
  const runSeconds = input.run_seconds ?? DEFAULT_RUN_SECONDS;
  const runMs = Math.max(runSeconds * MS_PER_S - REPORT_MARGIN_MS, LEAST_RUN_MS);
  const structured = input.result_schema !== undefined && input.result_schema !== null;
  const stop = new AbortController();
  const began = Date.now();
  const timer = setTimeout(() => stop.abort(new Error(TIME_STOP)), runMs);
  const benchmark = benchmarkControlOptions(began, new Date(began));
  // The answer is due by the deadline our runs set (benchmark.ts), or by the end of the run's own time when that comes
  // first.
  const deadline = Math.min(benchmark.deadline ?? Number.POSITIVE_INFINITY, began + runMs);
  const record: Record<string, unknown> = {
    start,
    goal,
    budget,
    runMs,
    deadlineS: (deadline - began) / MS_PER_S,
    system1: { model: process.env[SYSTEM1_MODEL_VARIABLE]?.trim() },
    system2: { model: model.model, reasoning: model.reasoning ?? null, provider: model.provider ?? null },
  };
  const teller = new Teller(serverName, budget);
  let calls = 0;
  let stopped: [kind: string, message: string] | undefined;
  let report: Report = { success: false, summary: "failed", finalAnswer: null };
  let facade: Facade | undefined;
  let browser: Browser | undefined;
  // The controller keeps within the budget itself (maxBrowserActions) and answers when it is spent; the stop is only
  // for a task that goes past it.
  const countCall = (): void => {
    calls++;
    if (calls > budget && !stop.signal.aborted) stop.abort(new Error(BUDGET_STOP));
  };
  /** Says what a step or a tool call is told as, and counts it when it is a tool call. */
  const tell = ({ events, counted }: Told): void => {
    for (const event of events) say(event);
    if (counted) countCall();
  };
  try {
    // 1. One facade call, so the harness captures its evidence.
    facade = await Facade.connect(port);
    await facade.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT });
    facade.notify("notifications/initialized");
    const id = String(calls + 1);
    say({ type: "tool_call", id, name: FIRST_FACADE_TOOL, server: serverName, args: { code: FIRST_FACADE_CODE } });
    const called = await facade.request("tools/call", {
      name: FIRST_FACADE_TOOL,
      arguments: { code: FIRST_FACADE_CODE },
    });
    const facadeResult = called.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
    say({
      type: "tool_result",
      id,
      name: FIRST_FACADE_TOOL,
      server: serverName,
      ok: !called.error && !facadeResult?.isError,
      text: cut(
        facadeResult?.content?.map((part) => part.text ?? "").join("\n") || JSON.stringify(called.error ?? {}),
        TEXT_MOST,
      ),
      images: [],
      structured: null,
    });
    countCall();

    // 2. karpo-browser on the task's browser, at the start page.
    const url = `${CONNECT_URL}?apiKey=${encodeURIComponent(key)}&sessionId=${encodeURIComponent(sessionId)}`;
    browser = await Browser.connect(url, {
      ...benchmarkBrowserOptions(),
      decider,
      // Requests packed to the model's limits, as the library packs them when it reads the SYSTEM1_* variables itself:
      // a decider given whole, as the counted one is, would get the default profile's.
      profile: profileFor(undefined, system1.limits),
    });
    await browser.open(start);
    const opened = browser;

    // 3. The controller works the task to its answer.
    const result = await control(controllerBrowser(opened), taskText(goal, input.system_prompt), {
      ...benchmark,
      model,
      deadline,
      // The evidence told for the judge is no call of the controller's: its browser actions are cut by as many as may
      // be told, besides the calls told before it starts.
      maxBrowserActions: browserActionsFor(budget, calls),
      // Each show is told as a tool call of its own: the controller is told the budget is spent by this count, a
      // little before it is, so it answers before the stop.
      spent: () => calls >= budget - BUDGET_RESERVE,
      signal: stop.signal,
      onStep: (step) => tell(teller.step(step, calls)),
      onTool: (event) => tell(teller.tool(event, calls)),
    });
    const last = result.runs.at(-1);
    record.runs = result.runs.map(({ page: _page, ...rest }) => rest);
    record.controller = {
      end: result.end,
      turns: result.turns,
      manualActions: result.manualActions,
      browserActions: result.browserActions,
      usage: result.usage,
      timing: result.timing,
    };
    report = {
      success: result.answered,
      summary: `${result.end}${last ? ` (last run: ${last.status})` : ""}`,
      finalAnswer: result.answered ? result.answer : null,
    };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (!stop.signal.aborted) stopped = [EXCEPTION_KIND, why];
    report = { success: false, summary: `failed: ${cut(why, REASON_MOST)}`, finalAnswer: null };
  } finally {
    clearTimeout(timer);
    const reason = stop.signal.aborted ? String((stop.signal.reason as Error | undefined)?.message ?? "") : "";
    if (reason === BUDGET_STOP) stopped = [TOOL_STEP_BUDGET_KIND, `the tool-call budget of ${budget} is spent`];
    else if (reason === TIME_STOP) stopped ??= [EXCEPTION_KIND, `the run's time of ${runSeconds} s is spent`];
    if (browser) record.timings = browser.timings();
    await browser?.close().catch(() => undefined);
    facade?.close();
  }
  if (stopped) say({ type: "error", kind: stopped[0], message: stopped[1] });
  record.steps = teller.steps;
  record.imagesTold = teller.imagesTold;
  record.decisions = {
    calls: decider.calls,
    failures: decider.failures,
    ms: decider.ms,
    bytes: decider.bytes,
    imageBytes: decider.imageBytes,
    ...(decider.usage.length > 0 ? { usage: decider.usage } : {}),
  };
  record.report = report;
  if (input.records_dir) {
    try {
      fs.mkdirSync(input.records_dir, { recursive: true });
      fs.writeFileSync(path.join(input.records_dir, RECORD_FILE), hidden(JSON.stringify(record, null, RECORD_INDENT)));
    } catch (error) {
      log(`the record is not written: ${(error as Error).message}`);
    }
  }
  const json = JSON.stringify(report);
  say(assistant(`${REPORT}${json}`));
  say({ type: "final", text: structured ? json : `${REPORT}${json}` });
  // System 2's tokens are in the record: the harness's model for this agent is only a label, which it cannot price.
  say({
    type: "usage",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    reported: false,
  });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A failure of the program itself is said as the protocol's error, without its stack.
    say({ type: "error", kind: EXCEPTION_KIND, message: error instanceof Error ? error.message : String(error) });
    process.exitCode = FAILED_EXIT;
  },
);
