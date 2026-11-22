/**
 * What the agent tells the harness as the controller works a task, and what it hides of its settings in all it says
 * and records. Each step of System 1, and each call of System 2's that reads or acts on the page, is told as a tool
 * call on the facade's server name: the harness records the page after it as it does after a facade call, and the call
 * counts against the tool-call budget, which the agent keeps. What takes no action on the page is told in words, except
 * the pages System 1 judged done that are told as evidence.
 */
import { addressShown } from "../../src/decider/systemone.ts";
import type { StepRecord } from "../../src/index.ts";
import { DONE_STEP, isEnding } from "../../src/index.ts";
import type { ToolEvent } from "../../test/controller/controller.ts";
import * as tools from "../../test/controller/tools.ts";

/** The keys the agent may know of, by their variables: Browserbase's, System 1's and System 2's. */
export const BROWSERBASE_KEY_VARIABLE = "BROWSERBASE_API_KEY";
const SYSTEM1_KEY_VARIABLE = "SYSTEM1_API_KEY";
export const SYSTEM2_KEY_VARIABLE = "SYSTEM2_API_KEY";
/** The judge's key: the program inherits it with the harness's environment. */
const JUDGE_KEY_VARIABLE = "OPENAI_API_KEY";
/** System 1's endpoint: a server of your own may be one that should not be named in what the harness keeps. */
const SYSTEM1_URL_VARIABLE = "SYSTEM1_URL";
/** A secret shorter than this is a placeholder (a test's), not hidden; what stands in for one that is. */
const SECRET_LEAST = 8;
const HIDDEN = "<secret>";
/** The host names of this machine, as a URL gives them: no secret, and the facade's bridge is on one of them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The most characters told of a text, and of an argument. */
export const TEXT_MOST = 100_000;
const ARGUMENT_MOST = 2_000;
/** The tool name a step is told under when its option names no operation, and the one a DONE page is told under. */
const STEP_TOOL = "step";
const DONE_TOOL = "done";
const JPEG_TYPE = "image/jpeg";
/** Tool calls kept back from the budget: past them only the answer is asked for. */
export const BUDGET_RESERVE = 2;
/**
 * The evidence the judge otherwise lacks, told as tool calls of their own: the page the task started on, as System 2
 * read it into the task's first message (one read), and the pages System 1 judged done, with their screenshots (at
 * most DONE_TOLD_MOST of them). Neither is a call of the controller's on the page, so without them the harness records
 * neither page.
 */
const START_READS_TOLD = 1;
export const DONE_TOLD_MOST = 6;
/**
 * The most evidence calls told (the start read and the DONE pages), which the controller does not count as its own:
 * its browser actions are cut by this many, so that its own count never lets them pass the budget. The values its
 * answer shows, which it does not count either, are held back by the budget's reserve instead (`spent` in agent.ts).
 */
export const EVIDENCE_ALLOWANCE = START_READS_TOLD + DONE_TOLD_MOST;
/** Browser actions kept back from what the controller may take, besides the calls told before it starts. */
const ACTION_RESERVE = 1;

/**
 * The browser actions the controller may take, `calls` tool calls having been told before it starts: what the budget
 * leaves past them, the reserve and the evidence, and none when it leaves nothing.
 */
export function browserActionsFor(budget: number, calls: number): number {
  return Math.max(0, budget - calls - ACTION_RESERVE - EVIDENCE_ALLOWANCE);
}

/** One of the protocol's events, as said on its own line (with `ts` added as it is said). */
export type ProtocolEvent = Record<string, unknown>;

/** A screenshot as the harness takes a tool result's image: evidence for the judge. */
interface Image {
  data: string;
  mime_type: string;
}

/** A step of System 1 as the record keeps it. */
export interface StepRow {
  n: number;
  key: string;
  element: string;
  url: string;
  note: string | null;
}

/** What a step or a tool call is told as: the events, in the order said, and whether they are a counted tool call. */
export interface Told {
  events: ProtocolEvent[];
  counted: boolean;
}

/**
 * What is hidden wherever the agent speaks or records, longest first so that a secret is hidden whole before a part of
 * it is: the keys `env` gives; System 1's address from SYSTEM1_URL as its errors quote it (without a user name,
 * password or query); and, as a failed connection quotes them alone, its host with the port and without it, unless it
 * is this machine. With SYSTEM1_URL unset, System 1 is at OpenRouter's public address: nothing to hide.
 */
export function secretsOf(env: Readonly<Record<string, string | undefined>>): string[] {
  const keys = [BROWSERBASE_KEY_VARIABLE, SYSTEM1_KEY_VARIABLE, SYSTEM2_KEY_VARIABLE, JUDGE_KEY_VARIABLE].map((name) =>
    env[name]?.trim(),
  );
  const given = env[SYSTEM1_URL_VARIABLE]?.trim() ?? "";
  const url = URL.parse(given);
  const address = url ? [addressShown(given)] : [];
  const hosts = url && !LOOPBACK_HOSTS.has(url.hostname) ? [url.host, url.hostname] : [];
  const secrets = [...keys, ...address, ...hosts].filter(
    (secret): secret is string => secret !== undefined && secret.length >= SECRET_LEAST,
  );
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

/** The text with each of the secrets in it hidden. */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((said, secret) => said.split(secret).join(HIDDEN), text);
}

/** The text cut to `most` characters, marked where it is cut. */
export function cut(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most)}…` : text;
}

/** Words said to the harness. */
export function assistant(text: string): ProtocolEvent {
  return { type: "assistant", text: cut(text, TEXT_MOST), reasoning: "", tool_calls: [], usage: null };
}

function imageOf(bytes: Uint8Array, mimeType: string): Image {
  return { data: Buffer.from(bytes).toString("base64"), mime_type: mimeType };
}

/** The option a step chose, in words: the description its question gave the option. */
function described(step: StepRecord): string {
  for (let i = step.requests.length - 1; i >= 0; i--) {
    const question = step.requests[i]?.questions.step;
    const words = question?.type === "choice" ? question.criteria[step.key] : undefined;
    if (typeof words === "string") return words;
  }
  return "";
}

/**
 * The telling of one task, on the facade's server name and against its tool-call budget: what each step of System 1
 * and each tool call of System 2 is told as, given the tool calls told before it, and what the record keeps of them.
 */
export class Teller {
  /**
   * The images told with System 2's calls (shows, compared pages) and with System 1's steps, the reads of the start
   * page told, and the DONE pages told with their screenshots.
   */
  readonly imagesTold = { tools: 0, steps: 0, starts: 0, done: 0 };
  /** System 1's steps, as the record keeps them. */
  readonly steps: StepRow[] = [];
  private readonly server: string;
  private readonly budget: number;

  constructor(server: string, budget: number) {
    this.server = server;
    this.budget = budget;
  }

  /** What a step of System 1 is told as, `calls` tool calls having been told before it. */
  step(step: StepRecord, calls: number): Told {
    const note = step.note ?? null;
    const text = JSON.stringify({ url: step.url, state: step.state, note });
    // A DONE page, with its screenshot, while fewer than DONE_TOLD_MOST were told and the budget holds more than its
    // reserve past this call.
    if (
      step.key === DONE_STEP &&
      step.readableScreenshot &&
      this.imagesTold.done < DONE_TOLD_MOST &&
      this.budget - (calls + 1) > BUDGET_RESERVE
    ) {
      this.imagesTold.done += 1;
      this.steps.push({ n: step.step, key: step.key, element: "", url: step.url, note });
      const args = { option: step.key, url: cut(step.url, ARGUMENT_MOST) };
      const images = [imageOf(step.readableScreenshot, JPEG_TYPE)];
      return { events: this.call(calls, DONE_TOOL, args, text, images), counted: true };
    }
    // Otherwise DONE, like an ending, is the run's judgment of the page, not an action on it: told in words, not counted.
    if (step.key === DONE_STEP || isEnding(step.key)) {
      this.steps.push({ n: step.step, key: step.key, element: "", url: step.url, note });
      return { events: [assistant(`${step.key}${step.note ? ` (${step.note})` : ""}`)], counted: false };
    }
    const words = described(step);
    const action = step.key.split(" ")[0]?.toLowerCase() || STEP_TOOL;
    const args = { option: step.key, element: cut(words, ARGUMENT_MOST), url: cut(step.url, ARGUMENT_MOST) };
    const images = step.readableScreenshot ? [imageOf(step.readableScreenshot, JPEG_TYPE)] : [];
    this.imagesTold.steps += images.length;
    this.steps.push({ n: step.step, key: step.key, element: words, url: step.url, note });
    const said = assistant(`${step.key}${words ? `: ${words}` : ""}${step.note ? ` (${step.note})` : ""}`);
    return { events: [said, ...this.call(calls, action, args, text, images)], counted: true };
  }

  /** What a tool call of System 2's is told as, `calls` tool calls having been told before it. */
  tool(event: ToolEvent, calls: number): Told {
    if (event.name === tools.RUN) {
      // Its steps were told one by one; its report is told in words only, as a tool call of its own would spend the
      // budget.
      const report = event.text.split("\n")[0] ?? "";
      return { events: [assistant(`${tools.RUN}: ${String(event.args.goal ?? "")} → ${report}`)], counted: false };
    }
    // finish is told through the report.
    if (event.name === tools.FINISH) return { events: [], counted: false };
    if (!event.ok) {
      return { events: [assistant(`${event.name} not done: ${cut(event.text, ARGUMENT_MOST)}`)], counted: false };
    }
    // The read of the start page into the task's first message is told as the read it is.
    if (event.start) this.imagesTold.starts += 1;
    const args = Object.fromEntries(
      Object.entries(event.args).map(([name, value]) => [
        name,
        typeof value === "string" ? cut(value, ARGUMENT_MOST) : value,
      ]),
    );
    const images = event.image ? [imageOf(event.image.bytes, event.image.mimeType)] : [];
    this.imagesTold.tools += images.length;
    return { events: this.call(calls, event.name, args, event.text, images), counted: true };
  }

  /** A tool call on the facade's server name and its result, the next of the `calls` told. */
  private call(calls: number, name: string, args: object, text: string, images: Image[]): ProtocolEvent[] {
    const id = String(calls + 1);
    return [
      { type: "tool_call", id, name, server: this.server, args },
      {
        type: "tool_result",
        id,
        name,
        server: this.server,
        ok: true,
        text: cut(text, TEXT_MOST),
        images,
        structured: null,
      },
    ];
  }
}
