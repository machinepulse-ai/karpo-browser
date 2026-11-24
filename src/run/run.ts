/**
 * One run: a goal worked on a page, step by step. Each step reads the page, asks the decision model which one step
 * moves the goal forward, and carries it out, until the model says the goal is reached (DONE), names an ending, or
 * the run stops by itself (its limits, going in circles, a stop from outside, a failure of its own).
 */

import { captureTab } from "../browser/capture.ts";
import type { Pages } from "../browser/pages.ts";
import type { Tab } from "../browser/tab.ts";
import * as actions from "../contracts/actions.ts";
import { maskTexts } from "../contracts/capture.ts";
import type { EndingKey } from "../contracts/endings.ts";
import { endingStatus } from "../contracts/endings.ts";
import * as statuses from "../contracts/statuses.ts";
import {
  EFFECT_CAPTCHA_NOT_SOLVED,
  EFFECT_CAPTCHA_SOLVED,
  EFFECT_GONE,
  EFFECT_NO_CAPTCHA,
  EFFECT_NO_OPTION_FITS,
  EFFECT_NO_VALUE_FITS,
  EFFECT_UNKNOWN,
  endingCode,
  Texts,
} from "../contracts/texts.ts";
import type { Weighed } from "../decider/answer.ts";
import { holds, likeliest, readFollowup, readStep, weighed } from "../decider/answer.ts";
import type { Packed, PackInput } from "../decider/pack.ts";
import { pack, packFinalists, TooBig } from "../decider/pack.ts";
import type { ElementContext, TaskValue } from "../decider/request.ts";
import {
  elementContext,
  followupName,
  NONE,
  OPTION,
  optionQuestion,
  request,
  STEP,
  VALUE,
  valueQuestion,
  withFollowups,
} from "../decider/request.ts";
import { imagePart, imageTokens, SCREENSHOT_JPEG_QUALITY, SCREENSHOT_MAX_WIDTH_PX } from "../decider/screenshot.ts";
import type { Decider, DecisionRequest, SystemOneQuestions } from "../decider/systemone.ts";
import type { Counter } from "../decider/tokens.ts";
import { estimate } from "../decider/tokens.ts";
import type { Profile } from "../profile.ts";
import { isWeb } from "../reading/state.ts";
import type { Element, SelectOption } from "../reading/tree.ts";
import { elementOf, pageScrolls } from "../reading/tree.ts";
import { wholeSelection, writePage } from "../reading/write.ts";
import type { Settling } from "./act.ts";
import { Acting } from "./act.ts";
import { Circles } from "./circles.ts";
import type { Taken } from "./history.ts";
import { History, takenOn, takenOnPage } from "./history.ts";
import type { Reading } from "./page.ts";
import { read } from "./page.ts";

/** The longest one decision may take. */
const DECISION_MS = 60_000;
/** The groups of a choice past the model's option limit asked at once, the others as these answer. */
const GROUPS_AT_ONCE = 4;
const MS_PER_SECOND = 1_000;
/** How many of the latest actions a result gives. */
const RESULT_ACTIONS = 5;
/** WAIT leaves the page alone until it reads differently, this long at most. */
const WAIT_MS = 3_000;
/** The longest a step's screenshot may take: the step is asked in words without it. */
const SCREENSHOT_WAIT_MS = 3_000;
/** How long a page that refuses the browser gets to move on by itself, looked at this often. */
const WALL_WAIT_MS = 6_000;
const WALL_LOOK_MS = 500;
/** How long a page still loading is given before an ending chosen on it is taken. */
const LOADING_LOOK_MS = 1_000;
/** Readings that may fail in a row, and how long the run waits before reading again. */
const READ_TRIES = 2;
const READ_RETRY_MS = 500;
/** What tells whether a page moved on: its address, title and readiness. */
const PAGE_MARK = "location.href + '\\n' + document.title + '\\n' + document.readyState";
const PAGE_URL = "location.href";
const READY_STATE = "document.readyState";
/** The document's ready state once it has loaded. */
const LOADED = "complete";
/** The ending a page that refuses the browser is. */
const BLOCKED: EndingKey = "BLOCKED";
/** A name that is a whole number. */
const WHOLE_NUMBER = /^\d+$/;
/** What a run stopped from outside says. */
const STOPPED = "the run was stopped";
/** Why a verification is not solved where the caller gave no solver. */
const NO_SOLVER = "no solver is set up";
/** Who solved a verification the browser solved itself, as the note names it. */
const BROWSER_SOLVER = "the browser";
/** Why a verification the browser was solving itself is not solved, where the caller gave no solver. */
const BROWSER_NOT_SOLVED = {
  failed: "the browser's own solving failed",
  unfinished: "the browser's own solving did not end in time",
} as const;
/** How many of a dropdown's options a SELECT none of whose options fit lists in its note. */
const NONE_FIT_OPTIONS = 20;
/** The most FILL and SELECT follow-ups asked in the step's own request (`mergeFollowups`). */
const MERGED_FOLLOWUPS = 3;

/** What a run is given: the goal, and what it may type. */
export interface RunInput {
  goal: string;
  /** The values the model may fill boxes with: `{what it is: the value}`. */
  values?: Readonly<Record<string, string>> | undefined;
  /**
   * Values the model chooses by name without seeing them (a password, a card number): typed into the page, never
   * sent to the model, their boxes masked in what it reads from then on.
   */
  secrets?: Readonly<Record<string, string>> | undefined;
}

/** What solving a page's verification challenge came to. */
export type CaptchaOutcome =
  | { outcome: "solved"; provider: string }
  /** The page shows no challenge to solve. */
  | { outcome: "none" }
  | { outcome: "failed"; reason: string };

/** One step of a run, as it was decided. */
export interface StepRecord {
  step: number;
  url: string;
  state: string;
  /** The requests the step asked, the last one the step's own (a viewport asked in groups asks them first). */
  requests: DecisionRequest[];
  /** The option the step is, and what the model saw when it ended. */
  key: string;
  note: string | undefined;
  /**
   * The viewport as a person can read it (RunOptions.readableScreenshot), taken while the model decided on the step;
   * none when the step's question carried no screenshot (screenshots off, a secret typed, none in time).
   */
  readableScreenshot?: Uint8Array | undefined;
}

export interface RunOptions {
  profile: Profile;
  decider: Decider;
  /** Stops the run from outside. */
  signal?: AbortSignal | undefined;
  /**
   * Solves the verification challenge the page shows, when the browser is not solving it itself; without it
   * SOLVE_CAPTCHA, when chosen and the browser solves nothing, says nothing can.
   */
  solveCaptcha?: ((tab: Tab, signal?: AbortSignal) => Promise<CaptchaOutcome>) | undefined;
  /** Hears each step as it is decided. */
  onStep?: ((step: StepRecord) => void) | undefined;
  /**
   * The screenshot a step's question carries: made 768 pixels wide by the browser (`scaled`, the default), at the
   * browser's own resolution (`full`: for a browser that crops a picture it is asked to scale), or none.
   */
  screenshot?: "scaled" | "full" | "none" | undefined;
  /**
   * Takes the viewport as a person can read it (Browser.readableScreenshot) for each step heard, while the model decides
   * on it, off the step's way (StepRecord.readableScreenshot); left out, none is taken.
   */
  readableScreenshot?: (() => Promise<Uint8Array | undefined>) | undefined;
  /**
   * How long a step waits for its screenshot once the page is read, in ms: one that comes later is left out and the
   * step asked in words alone, then waited for (`SCREENSHOT_WAIT_MS` from its start at most) before the step goes on
   * past its decision. Left out, the step waits for both (the screenshot `SCREENSHOT_WAIT_MS` at most).
   */
  screenshotGraceMs?: number | undefined;
  /** How the page is given time to settle after a step's action, and during a WAIT; act.ts's own, left out. */
  settling?: Settling | undefined;
  /**
   * Whether a step asks the tab's history where BACK goes while it reads the page, not once the page is read: a page
   * that moves on during the read may give another entry; off, left out.
   */
  backWithRead?: boolean | undefined;
  /**
   * Whether the FILL and SELECT follow-ups of the boxes and dropdowns the step offers in view are asked in the step's
   * own request, `MERGED_FOLLOWUPS` at most (`withFollowups`): a step that chooses one of them is carried out on that
   * answer, with no second request. Off, left out: a follow-up is asked after the step chose it.
   */
  mergeFollowups?: boolean | undefined;
}

/**
 * How a run ended: `done`, an ending the model named, or one the run ends on by itself (its limits, going in circles,
 * a stop from outside, a failure of its own).
 */
export type RunStatus =
  | "done"
  | "needs_from_person"
  | "needs_approval"
  | "site_cannot"
  | "blocked"
  | "page_unusable"
  | "other_failure"
  | "looping"
  | "limit"
  | "interrupted"
  | "failed";

/** How a run ended, and where. */
export interface RunResult {
  /** `done`, an ending's status, or one the run ends on by itself (`looping`, `limit`, `interrupted`, `failed`). */
  status: RunStatus;
  /** What the model saw when it ended, or why the run stopped. */
  detail: string;
  url: string;
  title: string;
  /** Decisions taken. */
  steps: number;
  seconds: number;
  /** The actions taken, what each did to what. */
  actions: string[];
  /** The latest actions with what each changed. */
  recent: string[];
  /** The page as the run last read it, one line an element, whole. */
  page: string[];
}

/** Where BACK goes: an entry of the tab's history, or the page that opened the tab. */
type Back = { entry: number } | "opener";

/** How a run ended, before its result is put together. */
interface Ended {
  status: RunStatus;
  detail: string;
}

/** A step's screenshot: the request's part, and the tokens it takes of the budget. */
interface StepImage {
  part: object;
  tokens: number;
}

/**
 * A FILL's or SELECT's follow-up: the number of its box or dropdown, the question as it is asked alone (`{value: …}`
 * or `{option: …}`) and its name, and the options its answer may choose.
 */
interface Followup {
  element: number;
  name: string;
  question: SystemOneQuestions;
  options: string[];
}

/** A run's own stop: what to end on instead of going on. */
class Stop extends Error {
  readonly ended: Ended;

  constructor(ended: Ended) {
    super(ended.detail);
    this.ended = ended;
  }
}

/** What an error says. */
function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(reason: string): Ended {
  return { status: statuses.FAILED, detail: reason };
}

/** A screenshot being taken, as it comes within SCREENSHOT_WAIT_MS; none, if it does not or it fails. */
function inTime<T>(taken: Promise<T>): Promise<T | undefined> {
  return within(
    taken.catch(() => undefined),
    SCREENSHOT_WAIT_MS,
  );
}

/** Runs one goal on the tab's page to its result. */
export function run(pages: Pages, input: RunInput, options: RunOptions): Promise<RunResult> {
  return new Run(pages, input, options).result();
}

class Run {
  private readonly pages: Pages;
  private readonly options: RunOptions;
  private readonly texts: Texts;
  private readonly goal: string;
  private readonly values: TaskValue[];
  /** The secrets' texts, by value number. */
  private readonly secretTexts = new Map<number, string>();
  private readonly history = new History();
  /** Whether the run is going in circles, as its steps show it. */
  private readonly circles = new Circles();
  private readonly started = Date.now();
  private readonly budget: number;
  private readonly counter: Counter;
  /** Decisions in a row that judged the run going in circles. */
  private loopingStreak = 0;
  /** When the latest WAIT's time is up, and when the latest page was read (epoch ms). */
  private waitUntil = 0;
  private readAt = 0;
  /** Page states given their look before an ending, where solving found no captcha, and hosts given their wait. */
  private readonly lookedLoading = new Set<string>();
  private readonly noCaptcha = new Set<string>();
  private readonly walls = new Set<string>();
  /** The history entry BACK goes to from the page as last read, if any. */
  private back: Back | undefined;
  /**
   * The step's screenshot while it may still be being taken, when the step went on without it (`screenshotGraceMs`).
   * A capture changes the tab's view until it is done, so it is waited for (no longer than a step waits for its
   * screenshot) before the step goes on past its decision, the page is shot again, or the run ends.
   */
  private shooting: Promise<unknown> | undefined;
  /** The options withheld by page state: FILL n or SELECT n a follow-up found nothing for. */
  private readonly withheld = new Map<string, Set<string>>();
  private last: Reading | undefined;

  constructor(pages: Pages, input: RunInput, options: RunOptions) {
    this.pages = pages;
    this.options = options;
    this.texts = new Texts(options.profile.texts);
    this.goal = input.goal;
    const given = Object.entries(input.values ?? {}).map(([name, text]) => ({ name, text, secret: false }));
    const secret = Object.entries(input.secrets ?? {}).map(([name, text]) => ({ name, text, secret: true }));
    // A name that is a whole number would be listed before the others whatever its place: the values' order, and so
    // their numbers, would not be the order given.
    const numeral = [...given, ...secret].find((value) => WHOLE_NUMBER.test(value.name));
    if (numeral) throw new Error(`the value named ${numeral.name} needs a name that says what it is for`);
    this.values = [...given, ...secret].map((value, index) => {
      if (value.secret) this.secretTexts.set(index + 1, value.text);
      return { n: index + 1, name: value.name, text: value.secret ? undefined : value.text };
    });
    const model = options.profile.decider;
    this.budget = Math.max(model.contextWindow - model.maxOutputTokens, 0);
    this.counter = estimate(model.charsPerToken);
  }

  /** The run's result. */
  async result(): Promise<RunResult> {
    let ended: Ended;
    try {
      ended = await this.steps();
    } catch (error) {
      if (error instanceof Stop) ended = error.ended;
      // Whatever a stop from outside broke off (a call, a wait), the run was stopped: that is how it ended.
      else if (this.options.signal?.aborted) ended = { status: statuses.INTERRUPTED, detail: STOPPED };
      else ended = failed(said(error));
    }
    await this.shotTaken();
    return {
      ...ended,
      url: this.last?.tree.url ?? "",
      title: this.last?.tree.title ?? "",
      steps: this.history.decisions,
      seconds: (Date.now() - this.started) / MS_PER_SECOND,
      actions: this.history.labels(),
      recent: this.history.latest(RESULT_ACTIONS).lines(undefined, this.texts),
      page: this.last
        ? writePage(this.last.tree, wholeSelection(), new Map(), this.options.profile.reading, this.texts).lines
        : [],
    };
  }

  /** The tab the run is on now. */
  private get tab(): Tab {
    return this.pages.current();
  }

  /** What carries a step out on the run's tab. */
  private get acting(): Acting {
    return new Acting(this.tab, this.texts, this.options.settling);
  }

  /** When the run's time is up (epoch ms). */
  private get deadline(): number {
    return this.started + this.options.profile.limits.runSeconds * MS_PER_SECOND;
  }

  private stopIfAsked(): void {
    if (this.options.signal?.aborted) throw new Stop({ status: statuses.INTERRUPTED, detail: STOPPED });
  }

  private async steps(): Promise<Ended> {
    const { limits, looping } = this.options.profile;
    const url = await this.tab.evaluate(PAGE_URL).catch(() => undefined);
    if (typeof url !== "string" || !isWeb(url)) return failed("no web page is open in the tab");
    let previous: { reading: Reading; taken: Taken } | undefined;
    let failedReads = 0;
    for (;;) {
      await this.shotTaken();
      this.stopIfAsked();
      if (this.history.decisions >= limits.maxSteps) {
        await this.readLast(previous);
        return { status: statuses.LIMIT, detail: `the step limit (${limits.maxSteps} steps)` };
      }
      if (Date.now() >= this.deadline) {
        await this.readLast(previous);
        const seconds = Math.round((Date.now() - this.started) / MS_PER_SECOND);
        return { status: statuses.LIMIT, detail: `the time limit (${seconds} seconds)` };
      }
      const readBegun = Date.now();
      // The screenshot is taken while the page is read: the same moment, off the step's way; where BACK goes too, when
      // the options say.
      const looked = this.read().catch((error: Error) => error);
      const shot = this.screenshot();
      const back = this.options.backWithRead ? this.backFrom() : undefined;
      const page = await looked;
      const image = await this.inGrace(shot);
      if (page instanceof Error) {
        failedReads += 1;
        if (failedReads < READ_TRIES) {
          await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
          continue;
        }
        this.unread(previous, page.message);
        return failed(page.message);
      }
      failedReads = 0;
      const { reading, loading } = page;
      this.back = await (back ?? this.backFrom());
      // A WAIT lasts until the page reads differently or its time is up: a change the reading does not show is
      // waited past.
      if (previous?.taken.operation === actions.WAIT && reading.state === previous.reading.state) {
        const moved =
          Date.now() < this.waitUntil &&
          (await this.tab.changed(readBegun, this.waitUntil, this.options.settling?.rules).catch(() => "unchanged"));
        if (moved && moved !== "unchanged") continue;
      }
      this.readAt = readBegun;
      if (previous) {
        this.history.took(previous.taken, previous.reading, reading, this.texts);
        this.circles.took(previous.taken, previous.reading, reading);
      }
      previous = undefined;
      this.history.read(reading);
      this.circles.read(reading);
      this.last = reading;
      // The screenshot comes before the words: the page's text gives it the room it takes.
      const room = Math.max(this.budget - (image?.tokens ?? 0), 0);
      const { packed, requests, ranked } = await this.packed(reading, room, image);
      const asked = this.options.mergeFollowups ? this.withFollowups(reading, packed, room, ranked) : packed.request;
      // Taken while the model decides, the page as the step's own screenshot showed it, and only when it has one.
      const readable = image && this.options.readableScreenshot ? inTime(this.options.readableScreenshot()) : undefined;
      const answered = await this.ask(asked, image);
      await this.shotTaken();
      const readableScreenshot = await readable;
      this.history.decisions += 1;
      const answer = readStep(answered, packed.options);
      const judgedLooping = answer.looping !== undefined && answer.looping >= looping.threshold;
      this.loopingStreak = judgedLooping ? this.loopingStreak + 1 : 0;
      this.options.onStep?.({
        step: this.history.decisions,
        url: reading.tree.url,
        state: reading.state,
        requests: [...requests, asked],
        key: answer.key,
        note: answer.note,
        ...(readableScreenshot ? { readableScreenshot } : {}),
      });
      const note = answer.note ?? "";
      if (answer.key === actions.DONE) return { status: statuses.DONE, detail: note };
      if (answer.ending) {
        previous = { reading, taken: await this.onEnding(answer.ending, note, reading, loading) };
        continue;
      }
      if (this.loopingStreak >= looping.streak) {
        return { status: statuses.LOOPING, detail: `judged going in circles ${this.loopingStreak} times in a row` };
      }
      const arrivals = this.circles.arrivals(reading);
      if (arrivals >= looping.arrivals) {
        return { status: statuses.LOOPING, detail: `back at the same page state ${arrivals} times` };
      }
      const round = this.circles.round(reading.tree, answer.key);
      if (round) {
        return {
          status: statuses.LOOPING,
          detail: `the same ${round.steps} steps taken ${round.rounds} times in a row`,
        };
      }
      const taken = await this.carryOut(reading, packed, answer.key, answered);
      await this.pages.adoptOpened();
      previous = { reading, taken };
    }
  }

  /** Whether the page reads as `reading` read it: in the same state. */
  private async unchanged(reading: Reading): Promise<boolean> {
    const now = await this.read().catch(() => undefined);
    return now?.reading.state === reading.state;
  }

  /** The page read: the tree the model reads, its state, and whether the document was still loading. */
  private async read(): Promise<{ reading: Reading; loading: boolean }> {
    // A page the browser is solving a verification on is read once that is over: what follows it is the page.
    await this.tab.browserSolve(undefined, this.options.signal);
    const [capture, ready] = await Promise.all([
      captureTab(this.tab),
      this.tab.evaluate(READY_STATE).catch(() => undefined),
    ]);
    maskTexts(capture, this.pages.typedTexts());
    const reading = read(capture, { reading: this.options.profile.reading, secrets: this.pages.typedSecrets() });
    return { reading, loading: typeof ready === "string" && ready !== LOADED };
  }

  /**
   * The page's screenshot; none once a secret was typed (a box covered over may still show what was typed elsewhere
   * on the page, as a card's preview does), nor when the page gives none in time.
   */
  private async screenshot(): Promise<StepImage | undefined> {
    const mode = this.options.screenshot ?? "scaled";
    if (mode === "none" || this.pages.secretTyped) return undefined;
    const width = mode === "scaled" ? SCREENSHOT_MAX_WIDTH_PX : undefined;
    const taken = this.tab.viewportJpeg(SCREENSHOT_JPEG_QUALITY, width).catch(() => undefined);
    const shot = await within(taken, SCREENSHOT_WAIT_MS);
    return shot ? { part: imagePart(shot.jpeg), tokens: imageTokens(shot.width, shot.height) } : undefined;
  }

  /**
   * The step's screenshot once the page is read: whenever it comes, or within `screenshotGraceMs` when given, the
   * screenshot then kept as `shooting` until it is waited for.
   */
  private inGrace(shot: Promise<StepImage | undefined>): Promise<StepImage | undefined> {
    const grace = this.options.screenshotGraceMs;
    if (grace === undefined) return shot;
    this.shooting = shot;
    return within(shot, grace);
  }

  /** Waits for the step's screenshot it went on without, if it may still be being taken. */
  private async shotTaken(): Promise<void> {
    const shooting = this.shooting;
    this.shooting = undefined;
    await shooting;
  }

  /** Where BACK goes from the page as it is: the history entry before the tab's current one, else its opener. */
  private async backFrom(): Promise<Back | undefined> {
    const history = (await this.tab.send("Page.getNavigationHistory").catch(() => undefined)) as
      | { currentIndex?: number; entries?: { id?: number }[] }
      | undefined;
    const entry = history?.entries?.[(history.currentIndex ?? 0) - 1]?.id;
    if (entry !== undefined) return { entry };
    return this.pages.canGoBackToOpener() ? "opener" : undefined;
  }

  /** BACK: in the tab's own history, or to the page that opened the tab. */
  private async goBack(): Promise<Taken> {
    if (this.back === undefined) throw new Stop(failed("the model chose BACK, with no page to go back to"));
    if (this.back !== "opener") return this.acting.back(this.back.entry);
    const taken = takenOnPage(actions.BACK);
    try {
      await this.pages.backToOpener();
      return taken;
    } catch (error) {
      return { ...taken, note: error instanceof Error ? error.message : String(error), done: false };
    }
  }

  /**
   * At a step or time limit, the action the run took last is read once more: its result then shows the page after
   * it, and the action among the latest, not the page it acted on.
   */
  private async readLast(previous: { reading: Reading; taken: Taken } | undefined): Promise<void> {
    if (!previous) return;
    try {
      const { reading } = await this.read();
      this.history.took(previous.taken, previous.reading, reading, this.texts);
      this.last = reading;
    } catch (error) {
      this.unread(previous, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The action taken last when the page after it could not be read: listed all the same. One that reached the page
   * with nothing said of it may have taken effect; one that did not, or that has a note, keeps what was said.
   */
  private unread(previous: { reading: Reading; taken: Taken } | undefined, reason: string): void {
    if (!previous) return;
    const { taken, reading } = previous;
    const said = taken.done && taken.note === undefined ? this.texts.fill(EFFECT_UNKNOWN, { reason }) : taken.note;
    this.history.took({ ...taken, note: said }, reading, reading, this.texts);
  }

  /** What a step's request is packed from, with `room` tokens for it. */
  private input(reading: Reading, room: number): PackInput {
    const profile = this.options.profile;
    const tree = reading.tree;
    const scrolls = pageScrolls(tree);
    const seconds = (Date.now() - this.started) / MS_PER_SECOND;
    return {
      tree,
      marks: profile.reading.triedMarks ? this.history.marks(reading, this.texts) : new Map(),
      reading: profile.reading,
      texts: this.texts,
      parts: {
        goal: this.goal,
        values: this.values,
        run: profile.reading.runSummary ? this.history.summary(reading, seconds) : undefined,
        url: tree.url,
        title: tree.title,
      },
      actions: this.history.recent(tree, Math.max(profile.reading.recentActionsMax, 0), this.texts),
      steps: {
        scrollDown: scrolls.down,
        scrollUp: scrolls.up,
        solveCaptcha: !this.noCaptcha.has(reading.state),
        back: this.back !== undefined,
      },
      withheld: this.withheld.get(reading.state) ?? new Set(),
      budget: room,
      maxChoices: profile.decider.maxChoices,
      counter: this.counter,
    };
  }

  /**
   * The step's request: the one that holds the viewport; or, when one does not, the finalists of its groups, each
   * group asked first (their requests come with it, and the finalists, likeliest first: `ranked`).
   */
  private async packed(
    reading: Reading,
    room: number,
    image: StepImage | undefined,
  ): Promise<{ packed: Packed; requests: DecisionRequest[]; ranked: string[] | undefined }> {
    try {
      const packing = pack(this.input(reading, room));
      if (packing.kind === "one") return { packed: packing.packed, requests: [], ranked: undefined };
      const groups = packing.groups;
      const answers = await inTurns(groups, GROUPS_AT_ONCE, (group) => this.ask(group.request, image));
      const ranked = groups.map((group, at) => weighed(answers[at], STEP, group.options.slice(0, group.elements)));
      const finalists = likeliest(ranked, packing.room);
      return {
        packed: packFinalists(this.input(reading, room), finalists, groups.length),
        requests: groups.map((group) => group.request),
        ranked: finalists,
      };
    } catch (error) {
      if (error instanceof TooBig) throw new Stop(failed(error.message));
      throw error;
    }
  }

  /** Asks the decision model, unless the run is stopped first. */
  private async ask(asked: DecisionRequest, image: StepImage | undefined): Promise<unknown> {
    this.stopIfAsked();
    const deadline = Math.min(Date.now() + DECISION_MS, this.deadline);
    const signal = this.options.signal;
    const context = { deadline, ...(image ? { image: image.part } : {}), ...(signal ? { signal } : {}) };
    // A stop asked while the model was deciding ends the run as stopped, whether the call then answered or failed:
    // its step is not carried out.
    const answer = await this.options.decider.ask(asked, context).finally(() => this.stopIfAsked());
    return answer;
  }

  /**
   * An ending the model chose: taken, unless the page was still loading (one more look), or it refuses the browser
   * and has yet to get its wait (a page that checks the browser can move on by itself within seconds).
   */
  private async onEnding(ending: EndingKey, note: string, reading: Reading, loading: boolean): Promise<Taken> {
    const wait = takenOnPage(actions.WAIT);
    if (loading && !this.lookedLoading.has(reading.state)) {
      this.lookedLoading.add(reading.state);
      this.waitUntil = Date.now() + LOADING_LOOK_MS;
      await this.tab.changed(this.readAt, this.waitUntil, this.options.settling?.rules).catch(() => {});
      return wait;
    }
    const host = URL.parse(reading.tree.url)?.hostname;
    if (ending === BLOCKED && host && !this.walls.has(host)) {
      this.walls.add(host);
      await this.movedOn();
      return wait;
    }
    const says = this.texts.get(endingCode(ending));
    throw new Stop({ status: endingStatus(ending), detail: note === "" ? says : note });
  }

  /** Looks at a page that is checking the browser until it moves on, or the wait is over. */
  private async movedOn(): Promise<void> {
    const mark = () => this.tab.evaluate(PAGE_MARK).catch(() => undefined);
    const before = await mark();
    for (const until = Date.now() + WALL_WAIT_MS; Date.now() < until; ) {
      await new Promise((resolve) => setTimeout(resolve, WALL_LOOK_MS));
      this.stopIfAsked();
      if ((await mark()) !== before) return;
    }
  }

  /**
   * The step's request with the follow-ups of the boxes and dropdowns it offers in view asked in it too
   * (`mergeFollowups`), each as it would be asked alone after the step: as many as `MERGED_FOLLOWUPS` and the budget
   * (`room`) hold, the likeliest first when the step's options were ranked in groups (`ranked`), else in page order.
   */
  private withFollowups(
    reading: Reading,
    packed: Packed,
    room: number,
    ranked: readonly string[] | undefined,
  ): DecisionRequest {
    const offered = packed.options.slice(0, packed.elements);
    const merged: Followup[] = [];
    let asked = packed.request;
    for (const key of ranked ?? offered) {
      if (merged.length >= MERGED_FOLLOWUPS) break;
      const followup = offered.includes(key) ? this.followupOf(reading, packed, key) : undefined;
      if (!followup) continue;
      const next = request(packed.request.state, withFollowups(packed.request.questions, [...merged, followup]));
      if (this.counter(JSON.stringify(next)) > room) continue;
      merged.push(followup);
      asked = next;
    }
    return asked;
  }

  /**
   * The follow-up a step's option asks after it: FILL's of a box in view when the run has values, SELECT's of a
   * dropdown in view with options to choose, all of which one follow-up holds (not asked in groups); none for another
   * option, nor where NONE is the only answer.
   */
  private followupOf(reading: Reading, packed: Packed, key: string): Followup | undefined {
    const { operation, number } = actions.readKey(key);
    const element = number === undefined ? undefined : elementOf(reading.tree, number);
    if (element?.part !== "viewport") return undefined;
    if (operation === actions.FILL) return this.values.length === 0 ? undefined : this.valueFollowup(reading, element);
    if (operation !== actions.SELECT || element.kind.kind !== "select") return undefined;
    const context = elementContext(reading.tree, element, this.texts);
    const enabled = element.kind.options.filter((option) => !option.disabled);
    if (enabled.length === 0 || this.optionGroups(packed, context, enabled).length > 1) return undefined;
    return this.optionFollowup(element, context, enabled);
  }

  /** Carries out the chosen step (an operation, not an ending); `answered` is the step's answer. */
  private async carryOut(reading: Reading, packed: Packed, key: string, answered: unknown): Promise<Taken> {
    const { operation, number } = actions.readKey(key);
    const element =
      number === undefined || number === actions.PAGE_NUMBER ? undefined : elementOf(reading.tree, number);
    switch (operation) {
      case actions.SCROLL_DOWN:
      case actions.SCROLL_UP:
        return this.acting.scroll(operation, element);
      case actions.WAIT:
        this.waitUntil = Date.now() + WAIT_MS;
        return this.acting.wait(this.readAt, this.waitUntil);
      case actions.ESCAPE:
        return this.acting.escape();
      case actions.REFRESH:
        return this.acting.refresh();
      case actions.SOLVE_CAPTCHA:
        return this.solveCaptcha(reading);
      case actions.BACK:
        return this.goBack();
    }
    if (!element) throw new Stop(failed(`the model chose ${key}, which the page does not have`));
    switch (operation) {
      case actions.CLICK:
        return this.acting.click(element, () => this.unchanged(reading));
      case actions.PRESS_ENTER:
        return this.acting.pressEnter(element);
      case actions.FILL:
        return this.fill(reading, packed, element, answered);
      case actions.SELECT:
        return this.select(reading, packed, element, answered);
      default:
        throw new Stop(failed(`the model chose ${key}, which the page does not have`));
    }
  }

  /** Withholds an option in a page state: it is not offered again while the page is in that state. */
  private withhold(state: string, key: string): void {
    const keys = this.withheld.get(state) ?? new Set();
    this.withheld.set(state, keys.add(key));
  }

  /**
   * A follow-up's choice, undefined for NONE: as the step's answer (`answered`) holds it when the step's own request
   * asked it (`mergeFollowups`); else asked now with the step's state.
   */
  private async followUp(packed: Packed, followup: Followup, answered: unknown): Promise<string | undefined> {
    const merged = followupName(followup.name, followup.element);
    if (this.options.mergeFollowups && holds(answered, merged)) return readFollowup(answered, merged, followup.options);
    const answer = await this.ask(request(packed.request.state, followup.question), undefined);
    return readFollowup(answer, followup.name, followup.options);
  }

  /** FILL's follow-up: which of the task's values goes into the box, or NONE. */
  private valueFollowup(reading: Reading, element: Element): Followup {
    const context = elementContext(reading.tree, element, this.texts);
    const question = valueQuestion(context, this.values, this.texts);
    const options = [...this.values.map((value) => String(value.n)), NONE];
    return { element: element.number, name: VALUE, question, options };
  }

  /** SELECT's follow-up over these of the dropdown's options: which of them, by live index, or NONE. */
  private optionFollowup(element: Element, context: ElementContext, asked: readonly SelectOption[]): Followup {
    const question = optionQuestion(context, asked, 0, this.texts);
    const options = [...asked.map((option) => String(option.index)), NONE];
    return { element: element.number, name: OPTION, question, options };
  }

  /** FILL: which value goes into the box, asked of the model with the step's state. */
  private async fill(reading: Reading, packed: Packed, element: Element, answered: unknown): Promise<Taken> {
    const chosen = await this.followUp(packed, this.valueFollowup(reading, element), answered);
    const value = this.values.find((candidate) => String(candidate.n) === chosen);
    if (!value) {
      // No value fits: not an ending, this box is withheld and the step asked again.
      this.withhold(reading.state, actions.optionKey(actions.FILL, element.number));
      return { ...takenOn(actions.FILL, element), note: this.texts.get(EFFECT_NO_VALUE_FITS), done: false };
    }
    if (value.text !== undefined)
      return { ...(await this.acting.fill(element, value.n, value.text)), value: value.name };
    const secret = this.secretTexts.get(value.n);
    if (secret === undefined) {
      return { ...takenOn(actions.FILL, element), note: this.texts.get(EFFECT_GONE), done: false };
    }
    return { ...(await this.acting.fillSecret(element, value.n, secret, this.pages)), value: value.name };
  }

  /** SELECT: which of the dropdown's options, by its live index, asked of the model. */
  private async select(reading: Reading, packed: Packed, element: Element, answered: unknown): Promise<Taken> {
    if (element.kind.kind !== "select") return this.acting.click(element, () => this.unchanged(reading));
    const options = element.kind.options;
    const context = elementContext(reading.tree, element, this.texts);
    const enabled = options.filter((option) => !option.disabled);
    const groups = this.optionGroups(packed, context, enabled);
    const asked = groups.length > 1 ? await this.shortlisted(packed, context, enabled, groups) : enabled;
    const chosen = await this.followUp(packed, this.optionFollowup(element, context, asked), answered);
    const option = options.find((candidate) => String(candidate.index) === chosen);
    if (!option) {
      // No option fits: not an ending, this dropdown is withheld and the step asked again, its options told.
      this.withhold(reading.state, actions.optionKey(actions.SELECT, element.number));
      const listed = options.slice(0, NONE_FIT_OPTIONS).map((each) => each.text);
      const note = this.texts.fill(EFFECT_NO_OPTION_FITS, { options: listed.join(", ") });
      return { ...takenOn(actions.SELECT, element), note, done: false };
    }
    return this.acting.select(element, option);
  }

  /** A follow-up's tokens with the step's state. */
  private optionTokens(packed: Packed, context: ElementContext, options: readonly SelectOption[]): number {
    return this.counter(JSON.stringify(request(packed.request.state, optionQuestion(context, options, 0, this.texts))));
  }

  /**
   * A dropdown's options cut, in their order, into groups each of which one follow-up holds with the step's state:
   * at most the options the model takes (NONE besides), at most its budget. One group when one holds them.
   */
  private optionGroups(packed: Packed, context: ElementContext, options: readonly SelectOption[]): SelectOption[][] {
    const limit = this.options.profile.decider.maxChoices;
    const room = limit === 0 ? Number.POSITIVE_INFINITY : Math.max(limit - 1, 0);
    const base = this.optionTokens(packed, context, []);
    const groups: SelectOption[][] = [[]];
    let spent = base;
    for (const option of options) {
      const cost = this.counter(JSON.stringify(String(option.index))) + this.counter(JSON.stringify(option.text)) + 2;
      const group = groups.at(-1)!;
      if (group.length > 0 && (group.length >= room || spent + cost > this.budget)) {
        groups.push([]);
        spent = base;
      }
      spent += cost;
      groups.at(-1)!.push(option);
    }
    return groups;
  }

  /**
   * A dropdown asked in groups: every group asked, the likeliest over every group kept, as many as one follow-up takes
   * and the budget holds with the step's state (one at least), in the dropdown's order.
   */
  private async shortlisted(
    packed: Packed,
    context: ElementContext,
    enabled: readonly SelectOption[],
    groups: readonly SelectOption[][],
  ): Promise<SelectOption[]> {
    const limit = this.options.profile.decider.maxChoices;
    const places = limit === 0 ? Number.POSITIVE_INFINITY : Math.max(limit - 1, 0);
    const state = packed.request.state;
    const answers = await inTurns(groups, GROUPS_AT_ONCE, (group) =>
      this.ask(request(state, optionQuestion(context, group, 0, this.texts)), undefined),
    );
    const ranked: Weighed[][] = groups.map((group, at) =>
      weighed(
        answers[at],
        OPTION,
        group.map((option) => String(option.index)),
      ),
    );
    const finalists = likeliest(ranked, places);
    for (let kept = finalists.length; ; kept -= Math.max(Math.floor(kept / 10), 1)) {
      const chosen = new Set(finalists.slice(0, kept));
      const asked = enabled.filter((option) => chosen.has(String(option.index)));
      const tokens = this.optionTokens(packed, context, asked);
      if (tokens <= this.budget) return asked;
      if (kept <= 1) throw new Stop(failed(new TooBig(tokens, this.budget).message));
    }
  }

  /**
   * SOLVE_CAPTCHA: the browser's own solving, when it is solving the challenge itself (Browserbase), waited for; else
   * the caller's solver. The option is offered whether or not there is one, as the model's requests always offered it;
   * chosen where nothing can solve, it is said so and not offered again in that page state.
   */
  private async solveCaptcha(reading: Reading): Promise<Taken> {
    const taken = takenOnPage(actions.SOLVE_CAPTCHA);
    const byBrowser = await this.tab.browserSolve(undefined, this.options.signal);
    if (byBrowser === "solved") {
      return { ...taken, note: this.texts.fill(EFFECT_CAPTCHA_SOLVED, { provider: BROWSER_SOLVER }) };
    }
    const solve = this.options.solveCaptcha;
    const solved: CaptchaOutcome = solve
      ? await solve(this.tab, this.options.signal).catch((error: unknown) => ({
          outcome: "failed",
          reason: said(error),
        }))
      : { outcome: "failed", reason: byBrowser === "none" ? NO_SOLVER : BROWSER_NOT_SOLVED[byBrowser] };
    if (solved.outcome === "solved") {
      return { ...taken, note: this.texts.fill(EFFECT_CAPTCHA_SOLVED, { provider: solved.provider }) };
    }
    if (solved.outcome === "none" || !solve) this.noCaptcha.add(reading.state);
    const note =
      solved.outcome === "none"
        ? this.texts.get(EFFECT_NO_CAPTCHA)
        : this.texts.fill(EFFECT_CAPTCHA_NOT_SOLVED, { reason: solved.reason });
    return { ...taken, note, done: false };
  }
}

/** What `promise` gives within `ms`; undefined past it. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** `work` on every item, `atOnce` at a time; the answers in the items' order. */
async function inTurns<T, R>(items: readonly T[], atOnce: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      answers[at] = await work(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
  return answers;
}
