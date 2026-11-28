/**
 * A task worked by the controller, a System 2 of our own: a general language model that plans, hands goals to the
 * decision model (run_browser_agent), reads the pages it reaches, acts by hand where a run is stuck, and answers, turn
 * by turn through tools. Every step a run takes is still the decision model's; the controller's own actions on the
 * page are few and counted.
 */
import type { ComparedPage, ManualAction, RunControls, RunInput, RunResult, StepRecord } from "../../src/index.ts";
import { DONE_STEP, imagePart, isEnding, pageExcerpt } from "../../src/index.ts";
import type { AskTurn, ChatModel, ToolCall, ToolSpec, Usage } from "./chat.ts";
import { httpTurns, pause } from "./chat.ts";
import { evidenceText } from "./evidence.ts";
import { normalized, statedValues, unseenNote, unseenValues } from "./grounding.ts";
import { systemPrompt, taskMessage } from "./prompt.ts";
import { cut } from "./text.ts";
import * as tools from "./tools.ts";

/** The most turns of the System 2 model in a task. */
const DEFAULT_MAX_TURNS = 40;
/** The most actions by hand in a task. */
const DEFAULT_MAX_MANUAL = 15;
/** How many of a page's lines a result gives; a longer page says how many more it has. */
const PAGE_MAX_LINES = 400;
/** How many of a page's lines an open answers with. */
const OPENED_LINES = 60;
/** The fewest browser actions a run is started with: fewer cannot reach anything. */
const MIN_RUN_ACTIONS = 3;
/** Turns answered in words alone before the words are taken as the answer. */
const WORDS_NUDGES = 1;
/** Words with which an answer says part of the task was not done, found or checked (persist). */
const GIVE_UP =
  /\b(couldn[’']?t|could not|can[’']?t|cannot|unable|(?:was|were)n[’']?t able|not able|not verified|(?:didn[’']?t|did not) (?:find|complete|verify|finish|check|place|reach|confirm|identify|get)|failed to)\b/i;
/** The least share of the task's time still left for an answer that gives up to be sent back to try another way. */
const PERSIST_LEFT_SHARE = 0.4;
/** The fewest browser actions still left for it. */
const PERSIST_LEAST_ACTIONS = 15;
/** What an answer that gives up early is answered with, once (persist). */
const PERSIST_NOTE =
  "Not finished yet: your answer says part of the task was not done, found or checked, and much of the time is left. Try another way first: reload or open the page again, the site's own search, menus or another listing, a clearer or smaller goal for run_browser_agent, or an action by hand where a run got stuck. Then finish, with what you reached, once the task is done or no other way is left.";
/** What the first finish is answered with while much of the time is left (checkFirst). */
const CHECK_NOTE =
  "Before this answer is taken, check it against the task: go through everything the task asks for (each item, value, comparison, candidate and step) one by one. If any part is missing, a placeholder, null or not verified, or a list was only partly gone through, and time is left, get it now with the tools. If every part is there with values the pages showed, call finish again with the answer.";
/** Turns that come back empty (no words, no calls) asked again before the task's last word is asked for. */
const EMPTY_RETRIES = 2;
/** Tool answers kept whole in the conversation, the latest ones; earlier ones keep their beginning only. */
const KEEP_FULL_ANSWERS = 3;
/** A tool answer this short stays whole however old it is. */
const SHORT_ANSWER_CHARS = 600;
/** How much of an earlier, longer answer stays. */
const KEPT_ANSWER_CHARS = 240;
/** Screenshots kept in the conversation, the latest ones. */
const KEEP_SHOTS = 2;
/** How long before a task's deadline its run is stopped and the answer asked for: time for one last turn. */
const FINISH_MARGIN_MS = 45_000;
/** The most values of an answer the page is scrolled to as the task finishes, so the page as seen shows them. */
const MOST_SHOWN = 3;
/**
 * How long the page stays as a show heard left it before anything moves it, with show taking several texts: whoever
 * watches the task takes its picture of the page a moment after hearing the show, through its own connection.
 */
const SHOW_HOLD_MS = 1_500;
const MS_PER_S = 1_000;
/** How many of a compared page's lines its answer gives: the answer of the most pages stays bounded. */
const COMPARED_LINES = 120;
/** How many lines before and after each line that holds look_for come first with it. */
const AROUND_LINES = 3;
/**
 * How long a compared page's text heard as evidence is, at most: whoever judges the task reads each text it chooses
 * only so far.
 */
const EVIDENCE_CHARS = 600;
/** The type of the screenshots a show (showEvidence) or a compare is told with. */
const JPEG_TYPE = "image/jpeg";

const NUDGE = "Call a tool to go on, or finish with the answer.";
const SPENT = "The task's actions on the browser are spent: finish now with the best answer from what you have read.";
const SHOT_CAPTION = "The page's screenshot after the last action.";
const LEFT_OUT = "(the rest is left out: read_page reads the page as it is now)";
const LAST_WORD =
  "Finish now with finish: give the best answer to the task from what you have read, or say what stopped it.";
const FINAL_TEXT =
  "Browsing has ended. Reply directly in the format the person requested. Use the evidence already collected and identify any missing fields.";
const HANDS_CLOSED =
  "Actions by hand are offered only right after a run stops short of its goal: give run_browser_agent this as a goal (the outcome to reach), or read the page.";
const LEFT_UNDONE =
  "Left undone: a call before it in this turn did not go through or changed the page. Call it again if it still fits the page as it is now.";

function handsOpen(count: number): string {
  return `(Actions by hand are open for ${count} actions: clear the point the run could not pass, then hand what comes after it back to run_browser_agent.)`;
}

/** The tools that, all gone through in a turn, have the next turn asked quickly when quickAfter is mechanical. */
const MECHANICAL_TOOLS: ReadonlySet<string> = new Set([...tools.MANUAL_TOOLS, tools.SHOW, tools.OPEN, tools.READ]);
/** The tools that do not change the page (a show only scrolls it): with multiShow, a turn goes on after them. */
const PAGE_KEEPING: ReadonlySet<string> = new Set([tools.SHOW, tools.READ]);

/** The run endings that open actions by hand when they follow failures only: all but these. */
const NOT_SHORT: ReadonlySet<string> = new Set(["done", "interrupted"]);

/** What a compare answers when fewer browser actions are left than it has pages. */
function tooFewLeft(pages: number, left: number): string {
  return `compare takes one browser action a page, and ${left} are left for its ${pages} pages: compare fewer, or finish with what you have.`;
}

/** What a show answers of a text it brought into view, and of one it could not find. */
function inView(text: string): string {
  return `"${text}" is in view`;
}

function notOnPage(text: string): string {
  return `"${text}" is not on this page as it reads now`;
}

function manualSpent(count: number): string {
  return `The ${count} actions by hand of this task are used: hand what is left to run_browser_agent.`;
}

/** Adds a turn's tokens to the task's. */
function addUsage(total: Usage, turn: Usage): void {
  total.input += turn.input;
  total.output += turn.output;
  if (turn.cached !== undefined) total.cached = (total.cached ?? 0) + turn.cached;
}

/** The time a task has used and has left before its answer is due, as each turn's results end. */
function timeNote(started: number, due: number, now: number): string {
  const used = Math.round((now - started) / MS_PER_S);
  const left = Math.max(0, Math.round((due - now) / MS_PER_S));
  return `(time: ${used} s used, ${left} s left before the answer is due)`;
}

/** What the controller works through. */
export interface ControllerBrowser {
  /** The address of the page that is open; empty when none is. */
  url(): string;
  open(url: string): Promise<void>;
  run(input: RunInput, controls: RunControls): Promise<RunResult>;
  read(): Promise<{ url: string; title: string; lines: string[] }>;
  /** Carries out an action by hand and says what came of it. */
  act(action: ManualAction): Promise<string>;
  /**
   * Scrolls the first words of the page that hold the text into view, at once with `instant` (whatever scroll
   * behaviour the page's style gives); whether there were any.
   */
  reveal?(text: string, instant?: boolean): Promise<boolean>;
  /** The viewport as a JPEG, when one can be taken. */
  screenshot(): Promise<Uint8Array | undefined>;
  /** The viewport as a JPEG a person can read, for whoever watches the task (showEvidence), when one can be taken. */
  readableScreenshot?(): Promise<Uint8Array | undefined>;
  /**
   * Reads each address in a background tab of its own, all at once, the tab in front left as it was; with `lookFor`,
   * each page is first scrolled to those words. The pages in the order given.
   */
  compare?(urls: readonly string[], lookFor: string | undefined): Promise<ComparedPage[]>;
}

/** A tool call as it ended, for whoever watches the task. */
export interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  text: string;
  /**
   * The page as the call left it, when it is told with one (a show with showEvidence, a compared page with compare):
   * the image and its type.
   */
  image?: { bytes: Uint8Array; mimeType: string } | undefined;
  /** The read of the start page into the task's first message (startPageInTask), not a call the model made. */
  start?: true | undefined;
}

export interface ControlOptions {
  model: ChatModel;
  /** No one can be asked: the controller makes the open choices itself. */
  unattended?: boolean | undefined;
  maxTurns?: number | undefined;
  maxManualActions?: number | undefined;
  /** The most actions on the browser: each page opened or read, each action by hand, each of a run's steps. */
  maxBrowserActions?: number | undefined;
  /**
   * Whether the browser actions are spent as the caller counts them: its own count may hold more than the controller's
   * (each run's report, each show it tells as a tool call of its own). Spent, only finish is offered.
   */
  spent?: (() => boolean) | undefined;
  /**
   * When given, actions by hand are offered only right after a run ends short of its goal (any ending but done and
   * interrupted), at most this many until the next run: the decision model does the browsing, and the controller plans,
   * reads and clears only what a run could not pass. Left out, they are offered throughout (up to maxManualActions).
   */
  handsAfterFailure?: number | undefined;
  /** Values the decision model types by name without anyone seeing them (a password), by name. */
  secrets?: Readonly<Record<string, string>> | undefined;
  signal?: AbortSignal | undefined;
  /** Hears each tool call as it ends. */
  onTool?: ((event: ToolEvent) => void) | undefined;
  /** Hears each step of a run as it is decided. */
  onStep?: ((step: StepRecord) => void) | undefined;
  /** How a turn is asked; over HTTP, left out. */
  ask?: AskTurn | undefined;
  /**
   * The reasoning effort of a turn that follows actions by hand that all went through (the next step of a form, a
   * click after a choice), where the model's own effort is spent on turns that plan; left out, every turn uses it.
   */
  quickReasoning?: ChatModel["reasoning"];
  /**
   * When the answer is due (epoch ms). Shortly before it, a run under way is stopped and the controller is asked for its
   * answer with finish alone; `signal` still stops everything at once.
   */
  deadline?: number | undefined;
  /**
   * show takes several texts (`texts`; `text` still works), brought into view in turn, each one found heard as a show
   * of its own, and the page held on it for showHoldMs; the prompt asks to put a page's shows in the turn that leaves
   * it, and a turn's calls after one that did not go through (a show that missed a text) or that changed the page (any
   * but a show or read_page) are left undone.
   */
  multiShow?: boolean | undefined;
  /**
   * How long the page stays as a show heard left it before anything moves it (its next text, the turn's next call),
   * for whoever watches to see it; left out, SHOW_HOLD_MS with multiShow (none with showEvidence), and none without.
   */
  showHoldMs?: number | undefined;
  /**
   * Each text a show (or finish, scrolling to the answer's values) brings into view is told with what whoever watches
   * needs to see it there without waiting on the page: the viewport's screenshot taken as the scroll settled
   * (readableScreenshot), and, as the event's text in place of what the controller is answered, the page's lines around
   * the text with its title and address (evidence.ts). The page is not held on a show unless showHoldMs says so, and
   * is scrolled at once (a page that scrolls smoothly would still be on its way when the screenshot is taken).
   */
  showEvidence?: boolean | undefined;
  /** open answers with the page up to the lines read_page gives, in place of its first lines. */
  openFullPage?: boolean | undefined;
  /** Once the actions by hand are all used, they are no longer offered. */
  hideSpentHands?: boolean | undefined;
  /**
   * The first message gives the page that is open as read_page reads it, read before the first turn, and the prompt
   * says it is already read. That read is no tool call, and is not counted as a browser action.
   */
  startPageInTask?: boolean | undefined;
  /** The prompt says every open and every action by hand answers with the page after it, so read_page seldom is. */
  pageInAnswers?: boolean | undefined;
  /**
   * How many of the latest tool answers stay whole in the conversation, a whole number from 0; left out,
   * KEEP_FULL_ANSWERS. Given (or with multiShow), the latest turn's answers all stay whole besides: the model has not
   * read them yet.
   */
  keepFullAnswers?: number | undefined;
  /** How many of the latest screenshots stay in the conversation, a whole number from 0; left out, KEEP_SHOTS. */
  keepShots?: number | undefined;
  /**
   * The turns quickReasoning follows: `hands` (left out), turns whose calls were all actions by hand that went through;
   * `mechanical`, also turns of shows, opens and page reads that went through, with actions by hand or alone.
   */
  quickAfter?: "hands" | "mechanical" | undefined;
  /**
   * The first finish whose answer gives up on part of the task ("could not", "not verified") while much of the time and
   * of the browser actions is left is sent back once to try another way; `persistTimes` sends such answers back that
   * many times.
   */
  persist?: boolean | undefined;
  persistTimes?: number | undefined;
  /**
   * The first finish, while much of the time and of the browser actions is left, is answered with a check of the
   * answer against everything the task asks for, once (for a model that stops before the task is done).
   */
  checkFirst?: boolean | undefined;
  /** Today's date as the first message gives it ("Wednesday, 18 November 2026"): dates in the task count from it. */
  today?: string | undefined;
  /**
   * finish's answer is all the person gets: the prompt says so, and words written in the turn that finishes (a table
   * the answer points to) go before the answer.
   */
  wholeAnswer?: boolean | undefined;
  /**
   * compare is offered: it reads 2 to 5 addresses side by side, each in a background tab of its own that is closed
   * again, the tab in front left as it was. Each page counts as one browser action and is heard as a tool call of its
   * own (compare_page) with the page's picture and a short text of it, the lines around look_for first. The prompt
   * says to use it for candidates checked side by side, and that facts to report are still shown on the page in front.
   */
  compare?: boolean | undefined;
}

/**
 * How a task ended: answered with finish, in words, out of turns, out of browser actions, at its deadline, or stopped
 * from outside.
 */
export type ControlEnd = "finished" | "words" | "turns" | "budget" | "time" | "interrupted";

export interface ControlResult {
  answer: string;
  /** False when the controller gave no answer of its own (out of turns, stopped). */
  answered: boolean;
  end: ControlEnd;
  turns: number;
  runs: RunResult[];
  manualActions: number;
  browserActions: number;
  usage: Usage;
  /** Where the task's time went: waiting on the System 2 model's turns, and working its tools (runs among them). */
  timing: { modelMs: number; toolMs: number };
}

/** Arguments a tool cannot use. */
class BadArguments extends Error {}

/** What a tool answered: its text, an image to show the model, and the answer when it was finish. */
interface Answered {
  text: string;
  ok: boolean;
  shot?: Uint8Array | undefined;
  answer?: string | undefined;
  /** Its parts were heard already, each as a tool call of its own (a show of several texts): the call itself is not. */
  heard?: boolean | undefined;
  /** What whoever watches is told in place of the text, with the page's screenshot (a show, with showEvidence). */
  told?: Told | undefined;
}

/** What whoever watches the task is told of a call: its text, and the page's screenshot when it is told with one. */
interface Told {
  text: string;
  image?: ToolEvent["image"];
}

function reportOf(result: RunResult): string {
  return [
    `${result.status}${result.detail ? `: ${result.detail}` : ""}`,
    `Page: ${result.title} (${result.url}), after ${result.steps} steps and ${Math.round(result.seconds)} s`,
    `Latest actions:\n${result.recent.join("\n") || "(none)"}`,
    `The page as the run last read it:\n${pageExcerpt(result.page, PAGE_MAX_LINES)}`,
  ].join("\n\n");
}

function argsOf(call: ToolCall): Record<string, unknown> {
  if (!call.arguments.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    throw new BadArguments(`${call.name}'s arguments are not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadArguments(`${call.name}'s arguments are not an object`);
  }
  return parsed as Record<string, unknown>;
}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new BadArguments(`${name} is a text, and it is missing`);
  return value;
}

/** show's texts: `texts`, or the one `text`. */
function textsOf(args: Record<string, unknown>): string[] {
  const given = args.texts;
  if (given === undefined || given === null) return [text(args, "text")];
  if (typeof given === "string" && given.trim()) return [given];
  if (!Array.isArray(given) || given.length === 0 || given.some((each) => typeof each !== "string" || !each.trim())) {
    throw new BadArguments("texts is a list of texts, as the page writes them");
  }
  return given as string[];
}

/** compare's addresses: 2 to 5 web addresses. */
function addressesOf(args: Record<string, unknown>): string[] {
  const given = args.urls;
  const count = `${tools.MIN_COMPARED} to ${tools.MAX_COMPARED}`;
  if (!Array.isArray(given) || given.length < tools.MIN_COMPARED || given.length > tools.MAX_COMPARED) {
    throw new BadArguments(`urls is a list of ${count} web addresses`);
  }
  if (given.some((url) => typeof url !== "string" || !/^https?:\/\//i.test(url))) {
    throw new BadArguments(`urls is a list of ${count} web addresses (http or https)`);
  }
  return given as string[];
}

/**
 * A compared page's lines, at most `most`: with words to look for, the lines around each line that holds them first
 * (`AROUND_LINES` either side), then the others, each part in the page's order; without, the first lines. The lines
 * that hold the words, besides.
 */
export function comparedLines(
  lines: readonly string[],
  lookFor: string | undefined,
  most: number,
): { lines: string[]; found: number } {
  const wanted = lookFor?.trim().toLowerCase();
  const holding = wanted ? lines.flatMap((line, at) => (line.toLowerCase().includes(wanted) ? [at] : [])) : [];
  const around = new Set(
    holding.flatMap((at) =>
      Array.from({ length: 2 * AROUND_LINES + 1 }, (_, i) => at - AROUND_LINES + i).filter(
        (near) => near >= 0 && near < lines.length,
      ),
    ),
  );
  const first = lines.filter((_, at) => around.has(at));
  const rest = lines.filter((_, at) => !around.has(at));
  return { lines: [...first, ...rest].slice(0, most), found: holding.length };
}

/** What a compare answers of a page, numbered among the pages it read. */
function comparedText(number: number, compared: ComparedPage, lookFor: string | undefined): string {
  if (!compared.page) return `${number}. ${compared.url}: ${compared.error ?? "not read"}`;
  const { page } = compared;
  const { lines, found } = comparedLines(page.lines, lookFor, COMPARED_LINES);
  const looked =
    lookFor === undefined
      ? []
      : [
          found > 0
            ? `"${lookFor}" is on ${found} of its lines: those and the lines around them come first.`
            : `"${lookFor}" is not on this page.`,
        ];
  const more = page.lines.length - lines.length;
  return [
    `${number}. ${page.title} (${page.url})`,
    ...looked,
    ...lines,
    ...(more > 0 ? [`(${more} more lines)`] : []),
  ].join("\n");
}

/** A compared page as whoever watches the task keeps it: a short text of it, the lines around look_for first. */
function comparedEvidence(compared: ComparedPage, lookFor: string | undefined): string {
  if (!compared.page) return `${compared.url}: ${compared.error ?? "not read"}`;
  const { page } = compared;
  const { lines } = comparedLines(page.lines, lookFor, COMPARED_LINES);
  return cut([`${page.title} (${page.url})`, ...lines.map((line) => line.trim())].join("\n"), EVIDENCE_CHARS);
}

function element(args: Record<string, unknown>): number {
  const value = args.element;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BadArguments("element is the element's number as the page reads");
  }
  return value;
}

/** field_values as a run takes them: texts by what each is for. */
function valuesOf(given: unknown): Record<string, string> {
  if (given === undefined || given === null) return {};
  if (!Array.isArray(given)) throw new BadArguments("field_values is a list of {name, text}");
  return Object.fromEntries(
    given.map((item) => {
      const name = (item as { name?: unknown })?.name;
      const value = (item as { text?: unknown })?.text;
      if (typeof name !== "string" || !["string", "number", "boolean"].includes(typeof value)) {
        throw new BadArguments("each of field_values is {name, text}");
      }
      return [name, String(value)];
    }),
  );
}

function manualActionOf(name: string, args: Record<string, unknown>): ManualAction {
  switch (name) {
    case tools.CLICK:
      return { kind: "click", element: element(args) };
    case tools.TYPE:
      return { kind: "type", element: element(args), text: text(args, "text"), enter: args.enter === true };
    case tools.SELECT:
      return { kind: "select", element: element(args), option: text(args, "option") };
    case tools.PRESS_ENTER:
      return { kind: "press_enter", element: element(args) };
    case tools.ESCAPE:
      return { kind: "escape" };
    case tools.SCROLL: {
      const direction = args.direction === "up" ? "up" : args.direction === "down" ? "down" : undefined;
      if (!direction) throw new BadArguments("direction is down or up");
      return { kind: "scroll", direction, element: args.element === undefined ? undefined : element(args) };
    }
    default:
      return { kind: "back" };
  }
}

/** One task's controller: its counts, the runs it made, and how it answers each tool. */
class Controller {
  private readonly browser: ControllerBrowser;
  private readonly options: ControlOptions;
  private readonly maxManual: number;
  /** The tools it may be offered, show and open as the options choose them. */
  private readonly specs: readonly ToolSpec[];
  readonly runs: RunResult[] = [];
  manual = 0;
  actions = 0;
  /** Everything the controller was given to read (the task, every tool answer), as values are looked for in it. */
  private read: string;
  /** Whether a finish has been checked for values no page showed: it is, once. */
  private checked = false;
  /** How many finishes that gave up have been sent back to try another way (persist). */
  private persisted = 0;
  /** Whether the first finish has been answered with the check against the task (checkFirst). */
  private firstChecked = false;
  /** When the task began (epoch ms), for the share of its time left. */
  private readonly began = Date.now();
  /** How long the page stays as a show heard left it (showHoldMs). */
  private readonly holdMs: number;
  /** Until when (epoch ms) the page stays as the latest show heard left it. */
  private heldUntil = 0;

  constructor(browser: ControllerBrowser, options: ControlOptions, task = "") {
    this.browser = browser;
    this.options = options;
    this.maxManual = options.maxManualActions ?? DEFAULT_MAX_MANUAL;
    this.specs = tools.chosenSpecs(tools.TOOL_SPECS, options);
    this.read = normalized(task);
    this.holdMs = options.showHoldMs ?? (options.multiShow && !options.showEvidence ? SHOW_HOLD_MS : 0);
  }

  /** The tools the model is offered now. */
  offered(): readonly ToolSpec[] {
    if (this.spent) return tools.FINISH_ONLY;
    const handless = this.handsClosed || this.handsHidden;
    return handless ? this.specs.filter((tool) => !tools.MANUAL_TOOLS.has(tool.name)) : this.specs;
  }

  /** The actions by hand are all used, and are no longer offered (hideSpentHands). */
  private get handsHidden(): boolean {
    return this.options.hideSpentHands === true && this.manual >= this.maxManual;
  }

  /** Actions by hand follow failures only, and none is open now. */
  private get handsClosed(): boolean {
    return this.options.handsAfterFailure !== undefined && this.handsLeft <= 0;
  }

  /** Whether the browser may take no more actions. */
  get spent(): boolean {
    const most = this.options.maxBrowserActions;
    return (most !== undefined && this.actions >= most) || this.options.spent?.() === true;
  }

  /** Whether an answer gives up on part of the task while much of its time and browser actions are left (persist). */
  private givesUpEarly(answer: string): boolean {
    const times = this.options.persistTimes ?? 1;
    if (!this.options.persist || this.persisted >= times || this.late || this.spent || !GIVE_UP.test(answer)) {
      return false;
    }
    return this.muchLeft();
  }

  /** Whether much of the task's time and of its browser actions is still left. */
  private muchLeft(): boolean {
    if (this.late || this.spent || this.left() < PERSIST_LEAST_ACTIONS) return false;
    const due = this.options.deadline;
    return due === undefined || (due - Date.now()) / (due - this.began) >= PERSIST_LEFT_SHARE;
  }

  /** Whether the task's deadline is close enough that only its answer is still asked for. */
  get late(): boolean {
    const due = this.options.deadline;
    return this.timeUp || (due !== undefined && Date.now() >= due - FINISH_MARGIN_MS);
  }

  /** Set when a run was stopped for the deadline: a timer may fire a moment before the clock reads it due. */
  private timeUp = false;
  /** Actions by hand still open after the latest run that stopped short (when they follow failures only). */
  private handsLeft = 0;

  private left(): number {
    const most = this.options.maxBrowserActions;
    return most === undefined ? Number.POSITIVE_INFINITY : most - this.actions;
  }

  async answer(call: ToolCall): Promise<Answered> {
    try {
      const answered = await this.call(call.name, argsOf(call));
      // What a page or a run gave, not what finish or show say back (they repeat the values asked about).
      if (call.name !== tools.FINISH && call.name !== tools.SHOW) this.read += ` ${normalized(answered.text)}`;
      return answered;
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      return { text: `error: ${error instanceof Error ? error.message : String(error)}`, ok: false };
    }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Answered> {
    if (name === tools.FINISH) {
      const answer = text(args, "answer");
      if (!this.checked && !this.late && !this.spent) {
        this.checked = true;
        const unseen = unseenValues(answer, this.read);
        if (unseen.length > 0) return { text: unseenNote(unseen), ok: false };
      }
      if (this.options.checkFirst && !this.firstChecked && this.muchLeft()) {
        this.firstChecked = true;
        return { text: CHECK_NOTE, ok: false };
      }
      if (this.givesUpEarly(answer)) {
        this.persisted++;
        return { text: PERSIST_NOTE, ok: false };
      }
      await this.showValues(answer);
      return { text: "finished", ok: true, answer };
    }
    if (tools.MANUAL_TOOLS.has(name) && this.handsClosed && !this.spent) {
      return { text: HANDS_CLOSED, ok: false };
    }
    if (tools.MANUAL_TOOLS.has(name) && this.handsHidden && !this.spent) {
      return { text: manualSpent(this.maxManual), ok: false };
    }
    if (!this.offered().some((tool) => tool.name === name) && !this.spent) {
      throw new BadArguments(`there is no tool ${name}`);
    }
    if (this.spent) return { text: SPENT, ok: false };
    // Reading does not move the page; anything else waits until the latest show has been seen.
    if (name !== tools.READ) await this.held();
    if (name === tools.SHOW) {
      if (this.options.multiShow) return this.showEach(textsOf(args));
      const wanted = text(args, "text");
      this.actions++;
      const shown = (await this.browser.reveal?.(wanted, this.options.showEvidence === true)) === true;
      const told = shown && this.options.showEvidence ? await this.evidence(wanted) : undefined;
      if (shown) this.hold();
      return {
        text: shown ? inView(wanted) : notOnPage(wanted),
        ok: shown,
        ...(told ? { told } : {}),
      };
    }
    if (name === tools.RUN) return this.run(args);
    if (name === tools.COMPARE) return this.compare(args);
    if (name === tools.OPEN) {
      const url = text(args, "url");
      if (!/^https?:\/\//i.test(url)) throw new BadArguments("url is a web address (http or https)");
      this.actions++;
      await this.browser.open(url);
      const page = await this.browser.read();
      const lines = pageExcerpt(page.lines, this.options.openFullPage ? PAGE_MAX_LINES : OPENED_LINES);
      return {
        text: `Opened: ${page.title} (${page.url})\n\n${lines}`,
        ok: true,
        shot: await this.shot(),
      };
    }
    if (name === tools.READ) {
      this.actions++;
      const page = await this.browser.read();
      return {
        text: `${page.title} (${page.url})\n\n${pageExcerpt(page.lines, PAGE_MAX_LINES, args.containing)}`,
        ok: true,
      };
    }
    if (this.manual >= this.maxManual) return { text: manualSpent(this.maxManual), ok: false };
    const action = manualActionOf(name, args);
    this.manual++;
    this.handsLeft--;
    this.actions++;
    const effect = await this.browser.act(action);
    const page = await this.browser.read();
    return {
      text: `${effect}\n\nThe page now: ${page.title} (${page.url})\n${pageExcerpt(page.lines, PAGE_MAX_LINES)}`,
      ok: true,
      shot: await this.shot(),
    };
  }

  private async run(args: Record<string, unknown>): Promise<Answered> {
    const goal = text(args, "goal");
    const values = valuesOf(args.field_values);
    if (this.left() < MIN_RUN_ACTIONS) return { text: SPENT, ok: false };
    // A new run closes what the last one's failure opened.
    this.handsLeft = 0;
    const stop = new AbortController();
    const outside = this.options.signal;
    const signal = outside ? AbortSignal.any([outside, stop.signal]) : stop.signal;
    const onStep = (step: StepRecord) => {
      // DONE and an ending are the run's own judgment of the page: they take no action on the browser.
      if (step.key !== DONE_STEP && !isEnding(step.key)) this.actions++;
      this.options.onStep?.(step);
      if (this.spent) stop.abort(new Error(SPENT));
    };
    const due = this.options.deadline;
    const timer =
      due === undefined
        ? undefined
        : setTimeout(
            () => {
              this.timeUp = true;
              stop.abort(new Error(LAST_WORD));
            },
            Math.max(due - FINISH_MARGIN_MS - Date.now(), 0),
          );
    let result: RunResult;
    try {
      result = await this.browser.run(
        { goal, values, ...(this.options.secrets ? { secrets: this.options.secrets } : {}) },
        { signal, onStep },
      );
    } finally {
      clearTimeout(timer);
    }
    this.runs.push(result);
    const hands = this.options.handsAfterFailure;
    let report = reportOf(result);
    if (hands !== undefined && hands > 0 && !NOT_SHORT.has(result.status)) {
      this.handsLeft = hands;
      report = `${report}\n\n${handsOpen(hands)}`;
    }
    return { text: report, ok: result.status !== "failed", shot: await this.shot() };
  }

  /**
   * Reads the addresses side by side in background tabs, one browser action a page, each page heard as a tool call of
   * its own with its picture and a short text of it; the answer gives every page's lines.
   */
  private async compare(args: Record<string, unknown>): Promise<Answered> {
    const urls = addressesOf(args);
    const lookFor = typeof args.look_for === "string" && args.look_for.trim() ? args.look_for.trim() : undefined;
    if (!this.browser.compare) throw new Error("this browser does not compare pages");
    if (urls.length > this.left()) return { text: tooFewLeft(urls.length, this.left()), ok: false };
    this.actions += urls.length;
    const pages = await this.browser.compare(urls, lookFor);
    for (const compared of pages) {
      this.options.onTool?.({
        name: tools.COMPARE_PAGE,
        args: { url: compared.url, ...(lookFor === undefined ? {} : { look_for: lookFor }) },
        ok: compared.page !== undefined,
        text: comparedEvidence(compared, lookFor),
        ...(compared.shot ? { image: { bytes: compared.shot, mimeType: JPEG_TYPE } } : {}),
      });
    }
    return {
      text: pages.map((compared, i) => comparedText(i + 1, compared, lookFor)).join("\n\n"),
      ok: pages.some((compared) => compared.page !== undefined),
      heard: pages.length > 0,
    };
  }

  private async shot(): Promise<Uint8Array | undefined> {
    if (!this.options.model.vision) return undefined;
    return this.browser.screenshot().catch(() => undefined);
  }

  /**
   * Brings each text into view in turn, each one found heard as a show of its own so whoever watches the task sees the
   * page with it, until the browser actions are spent; the answer says which were found, and it went through only when
   * all were.
   */
  private async showEach(wanted: readonly string[]): Promise<Answered> {
    const said: string[] = [];
    let found = 0;
    for (const each of wanted) {
      if (this.spent) {
        said.push(SPENT);
        break;
      }
      await this.held();
      this.actions++;
      const shown = (await this.browser.reveal?.(each, this.options.showEvidence === true)) === true;
      if (shown) {
        found++;
        await this.hearShown(each);
      }
      said.push(shown ? inView(each) : notOnPage(each));
    }
    return { text: said.join("\n"), ok: found === wanted.length, heard: found > 0 };
  }

  /**
   * Tells whoever watches the task that a text was brought into view, as a show of its own (with showEvidence, with
   * the page's screenshot and its lines around the text), and holds the page on it while they see it.
   */
  private async hearShown(value: string): Promise<void> {
    const told = this.options.showEvidence ? await this.evidence(value) : { text: inView(value) };
    this.options.onTool?.({ name: tools.SHOW, args: { text: value }, ok: true, ...told });
    this.hold();
  }

  /**
   * What whoever watches is told of a text a show brought into view (showEvidence): the page's lines around it with
   * its title and address, and the viewport's screenshot, taken together; what could not be had is left out.
   */
  private async evidence(value: string): Promise<Told> {
    const [page, shot] = await Promise.all([
      this.browser.read().catch(() => undefined),
      this.browser.readableScreenshot?.().catch(() => undefined),
    ]);
    const text = page ? evidenceText(inView(value), page, value) : inView(value);
    return shot ? { text, image: { bytes: shot, mimeType: JPEG_TYPE } } : { text };
  }

  /** Keeps the page as it is now for the show hold: whoever watches sees it a moment after hearing the show. */
  private hold(): void {
    this.heldUntil = Date.now() + this.holdMs;
  }

  /** Waits out what is left of the latest show's hold. */
  private async held(): Promise<void> {
    const left = this.heldUntil - Date.now();
    if (left > 0) await pause(left, this.options.signal);
  }

  /**
   * Scrolls the page that is open to the answer's amounts, percentages and decimals it holds, the first of them last
   * so the page ends on it; each one found is heard as a show, so whoever watches the task sees the page with it.
   */
  private async showValues(answer: string): Promise<void> {
    const reveal = this.browser.reveal?.bind(this.browser);
    if (!reveal) return;
    for (const value of statedValues(answer).slice(0, MOST_SHOWN).reverse()) {
      if (this.spent) return;
      await this.held();
      const shown = await reveal(value, this.options.showEvidence === true).catch(() => false);
      if (shown) await this.hearShown(value);
    }
  }
}

/** Refuses an option that counts something unless it is left out or a whole number from 0. */
function wholeFromZero(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
    throw new Error(`${name} is a whole number from 0, not ${value}`);
  }
}

/** Stops a model request, including its HTTP retries, at the end of the time reserved for it. */
function until(deadline: number | undefined, outside: AbortSignal | undefined): AbortSignal | undefined {
  if (deadline === undefined) return outside;
  const left = deadline - Date.now();
  const clock = left > 0 ? AbortSignal.timeout(Math.ceil(left)) : AbortSignal.abort();
  return outside ? AbortSignal.any([outside, clock]) : clock;
}

/** Works a task said in words to its answer, through a System 2 model and its tools. */
export async function control(
  browser: ControllerBrowser,
  task: string,
  options: ControlOptions,
): Promise<ControlResult> {
  wholeFromZero("keepFullAnswers", options.keepFullAnswers);
  wholeFromZero("keepShots", options.keepShots);
  wholeFromZero("showHoldMs", options.showHoldMs);
  const ask = options.ask ?? httpTurns();
  const started = Date.now();
  /** When the answer is due: the run is stopped and the last word asked for a margin before the deadline. */
  const due = options.deadline === undefined ? undefined : options.deadline - FINISH_MARGIN_MS;
  const workSignal = until(due, options.signal);
  const usage: Usage = { input: 0, output: 0 };
  const timing = { modelMs: 0, toolMs: 0 };
  /** A model turn, its time counted. */
  const asked: AskTurn = async (model, messages, offered, signal) => {
    const began = Date.now();
    try {
      return await ask(model, messages, offered, signal);
    } finally {
      timing.modelMs += Date.now() - began;
    }
  };
  const startPage = options.startPageInTask ? await readStart(browser, timing) : undefined;
  // Told as the read it is (marked start, on the event: a call's args are the model's), so that a caller recording
  // what the controller saw has it too.
  if (startPage !== undefined) options.onTool?.({ name: tools.READ, args: {}, ok: true, text: startPage, start: true });
  const controller = new Controller(browser, options, startPage === undefined ? task : `${task} ${startPage}`);
  const settings = {
    unattended: options.unattended ?? false,
    manualActions: options.maxManualActions ?? DEFAULT_MAX_MANUAL,
    browserCalls: options.maxBrowserActions,
    timed: due !== undefined,
    handsAfterFailure: options.handsAfterFailure,
    multiShow: options.multiShow,
    startPageRead: startPage !== undefined,
    pageInAnswers: options.pageInAnswers === true,
    wholeAnswer: options.wholeAnswer,
    compare: options.compare,
  };
  const first = taskMessage(task, browser.url(), Object.keys(options.secrets ?? {}), startPage, options.today);
  const messages: unknown[] = [
    { role: "system", content: systemPrompt(settings) },
    { role: "user", content: due === undefined ? first : `${first}\n\n${timeNote(started, due, started)}` },
  ];
  /** finish's answer, after the words of its turn that it does not already hold when the answer is to be whole. */
  const finalAnswer = (answer: string, words: string): string => {
    const said = words.trim();
    return options.wholeAnswer && said && !answer.includes(said) ? `${said}\n\n${answer}` : answer;
  };
  const ended = (answer: string, answered: boolean, end: ControlEnd, turns: number): ControlResult => ({
    answer,
    answered,
    end,
    turns,
    runs: controller.runs,
    manualActions: controller.manual,
    browserActions: controller.actions,
    usage,
    timing,
  });
  /** One last turn with finish alone, for the answer the task would otherwise end without. */
  const lastWord = async (end: ControlEnd, turns: number): Promise<ControlResult> => {
    if (options.signal?.aborted) return ended(lastWords, false, "interrupted", turns);
    const finishSignal = until(options.deadline, options.signal);
    if (finishSignal?.aborted) return ended(lastWords, false, "time", turns);
    const model = { ...options.model, reasoning: options.quickReasoning ?? options.model.reasoning };
    for (const withTool of [true, false]) {
      if (finishSignal?.aborted) break;
      turns++;
      const prompt = { role: "user", content: withTool ? LAST_WORD : FINAL_TEXT };
      try {
        const turn = await asked(
          withTool ? { ...model, toolChoice: "required" } : model,
          [...messages, prompt],
          withTool ? tools.FINISH_ONLY : [],
          finishSignal,
        );
        finishSignal?.throwIfAborted();
        addUsage(usage, turn.usage);
        const finish = turn.calls.find((call) => call.name === tools.FINISH);
        const answer = finish ? safeArgs(finish).answer : undefined;
        if (typeof answer === "string" && answer.trim()) return ended(answer, true, end, turns);
        if (turn.text.trim()) return ended(turn.text, true, end, turns);
      } catch {
        if (options.signal?.aborted) return ended(lastWords, false, "interrupted", turns);
        // A provider may reject the forced tool call. The same evidence can still be answered in words.
      }
    }
    return ended(lastWords, false, end, turns);
  };
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  /** The tools that, all gone through in a turn, have the next turn asked with the quick reasoning effort. */
  const quickTools = options.quickAfter === "mechanical" ? MECHANICAL_TOOLS : tools.MANUAL_TOOLS;
  const kept: Kept = {
    answers: options.keepFullAnswers,
    shots: options.keepShots,
    latestTurn: options.multiShow === true || options.keepFullAnswers !== undefined,
  };
  let nudges = 0;
  let empties = 0;
  let lastWords = "";
  /** Whether the last turn's calls were all of quickTools and went through. */
  let routine = false;
  for (let turns = 1; turns <= maxTurns; turns++) {
    if (options.signal?.aborted) return ended(lastWords, false, "interrupted", turns - 1);
    if (controller.late || workSignal?.aborted) return lastWord("time", turns - 1);
    const offered = controller.offered();
    const model =
      routine && options.quickReasoning ? { ...options.model, reasoning: options.quickReasoning } : options.model;
    let turn: Awaited<ReturnType<AskTurn>>;
    try {
      turn = await asked(model, messages, offered, workSignal);
      workSignal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) return ended(lastWords, false, "interrupted", turns - 1);
      if (workSignal?.aborted) return lastWord("time", turns - 1);
      throw error;
    }
    addUsage(usage, turn.usage);
    messages.push(turn.message);
    if (turn.text.trim()) lastWords = turn.text;
    routine = false;
    if (turn.calls.length === 0) {
      if (!turn.text.trim()) {
        if (empties < EMPTY_RETRIES) {
          empties++;
          messages.push({ role: "user", content: NUDGE });
          continue;
        }
        return lastWord("words", turns);
      }
      if (nudges < WORDS_NUDGES && !controller.spent) {
        nudges++;
        messages.push({ role: "user", content: NUDGE });
        continue;
      }
      return ended(turn.text, true, "words", turns);
    }
    let shot: Uint8Array | undefined;
    let allRoutine = true;
    /** Whether the turn's calls from here on are left undone (multiShow). */
    let undone = false;
    for (const call of turn.calls) {
      const began = Date.now();
      const answered: Answered = undone ? { text: LEFT_UNDONE, ok: false } : await controller.answer(call);
      timing.toolMs += Date.now() - began;
      messages.push({ role: "tool", tool_call_id: call.id, content: answered.text });
      if (!answered.heard) {
        const told = answered.told ?? { text: answered.text };
        options.onTool?.({ name: call.name, args: safeArgs(call), ok: answered.ok, ...told });
      }
      allRoutine &&= answered.ok && quickTools.has(call.name);
      if (answered.answer !== undefined) return ended(finalAnswer(answered.answer, turn.text), true, "finished", turns);
      shot = answered.shot ?? shot;
      // The calls after it were chosen on a page as it was before: a miss is set right while its page is still open.
      undone ||= options.multiShow === true && (!answered.ok || !PAGE_KEEPING.has(call.name));
    }
    if (due !== undefined) {
      // The turn's last tool answer ends with the time: the controller plans the task's parts by it.
      const last = messages.length - 1;
      const answer = messages[last] as { content: string };
      messages[last] = { ...answer, content: `${answer.content}\n\n${timeNote(started, due, Date.now())}` };
    }
    routine = allRoutine;
    if (shot) messages.push({ role: "user", content: [{ type: "text", text: SHOT_CAPTION }, imagePart(shot)] });
    trimHistory(messages, kept);
    if (controller.spent && turns < maxTurns) messages.push({ role: "user", content: SPENT });
  }
  return lastWord(controller.spent ? "budget" : "turns", maxTurns);
}

/**
 * The page that is open as read_page gives it, for the task's first message (startPageInTask), its time counted as the
 * tools'; none when no page is open or it could not be read.
 */
async function readStart(browser: ControllerBrowser, timing: { toolMs: number }): Promise<string | undefined> {
  if (!browser.url()) return undefined;
  const began = Date.now();
  const page = await browser.read().catch(() => undefined);
  timing.toolMs += Date.now() - began;
  return page && `${page.title} (${page.url})\n\n${pageExcerpt(page.lines, PAGE_MAX_LINES)}`;
}

/**
 * How many of the latest tool answers stay whole, and of the latest screenshots stay; left out, the defaults. With
 * `latestTurn`, the answers since the latest assistant message also stay whole however many they are: the model has
 * not read them yet.
 */
export interface Kept {
  answers?: number | undefined;
  shots?: number | undefined;
  latestTurn?: boolean | undefined;
}

/**
 * Keeps the conversation from growing with every page read: the latest tool answers stay whole and earlier long ones
 * keep their beginning, and only the latest screenshots stay. Messages are replaced, never changed in place.
 */
export function trimHistory(messages: unknown[], kept: Kept = {}): void {
  const keepAnswers = kept.answers ?? KEEP_FULL_ANSWERS;
  const keepShots = kept.shots ?? KEEP_SHOTS;
  let answers = 0;
  let shots = 0;
  /** Whether the messages gone through so far all came after the latest assistant message. */
  let unread = kept.latestTurn === true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown>;
    if (message.role === "assistant") unread = false;
    if (message.role === "tool" && typeof message.content === "string") {
      answers++;
      const content = message.content;
      if (!unread && answers > keepAnswers && content.length > SHORT_ANSWER_CHARS && !content.endsWith(LEFT_OUT)) {
        messages[i] = { ...message, content: `${content.slice(0, KEPT_ANSWER_CHARS)}… ${LEFT_OUT}` };
      }
    } else if (message.role === "user" && Array.isArray(message.content)) {
      const image = message.content.some((part) => (part as { type?: unknown })?.type === "image_url");
      if (image && ++shots > keepShots) messages.splice(i, 1);
    }
  }
}

function safeArgs(call: ToolCall): Record<string, unknown> {
  try {
    return argsOf(call);
  } catch {
    return { arguments: call.arguments };
  }
}
