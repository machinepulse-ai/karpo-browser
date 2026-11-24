/**
 * karpo-browser: drives a browser with a decision model. At each step the model reads the page and picks one action,
 * in one forward pass, until the goal is reached or something stops the run.
 *
 * ```ts
 * const browser = await Browser.launch();
 * await browser.open("https://www.example.com");
 * const result = await browser.run({ goal: "Book a table for 2 tonight at 7pm", values: { name: "Ann" } });
 * await browser.close();
 * ```
 */

import { captureTab } from "./browser/capture.ts";
import { Connection } from "./browser/cdp.ts";
import type { LaunchOptions, LocalChrome } from "./browser/chrome.ts";
import { launchChrome } from "./browser/chrome.ts";
import { Pages } from "./browser/pages.ts";
import { revealScript } from "./browser/reveal.ts";
import type { SettleRules } from "./browser/tab.ts";
import { Tab } from "./browser/tab.ts";
import type { TimingsRecord } from "./browser/timings.ts";
import * as actions from "./contracts/actions.ts";
import { maskTexts } from "./contracts/capture.ts";
import { Texts } from "./contracts/texts.ts";
import { SCREENSHOT_JPEG_QUALITY, SCREENSHOT_MAX_WIDTH_PX } from "./decider/screenshot.ts";
import { profileFor, system1Of } from "./decider/system1.ts";
import type { Decider, SystemOneOptions } from "./decider/systemone.ts";
import { items, member, string } from "./json.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { isWeb } from "./reading/state.ts";
import { elementOf } from "./reading/tree.ts";
import { wholeSelection, writePage } from "./reading/write.ts";
import type { Settling } from "./run/act.ts";
import { Acting } from "./run/act.ts";
import type { Taken } from "./run/history.ts";
import { read } from "./run/page.ts";
import type { CaptchaOutcome, RunInput, RunResult, StepRecord } from "./run/run.ts";
import { run } from "./run/run.ts";

export type { CallOptions } from "./browser/cdp.ts";
export { CdpClosed, CdpError, CdpTimeout } from "./browser/cdp.ts";
export type { LaunchOptions } from "./browser/chrome.ts";
export type { Key, OpenedTab, Point, RefusalReason, SettleEnd, SettleRules, Shot, TabFrame } from "./browser/tab.ts";
export { InputRefused, Tab } from "./browser/tab.ts";
export { DONE as DONE_STEP } from "./contracts/actions.ts";
export { isEnding } from "./contracts/endings.ts";
export type { ModelLimits } from "./decider/models.ts";
export { limitsOf, MODEL_LIMITS, UNKNOWN_MODEL_LIMITS } from "./decider/models.ts";
export { imagePart } from "./decider/screenshot.ts";
export { system1Of } from "./decider/system1.ts";
export type {
  AskContext,
  ChoiceAnswer,
  ChoiceQuestion,
  Decider,
  DecisionRequest,
  NoulAnswer,
  NoulQuestion,
  SystemOneAnswer,
  SystemOneOptions,
  SystemOneQuestion,
  SystemOneQuestions,
  SystemOneRequest,
  SystemOneState,
  SystemOneStateItems,
  SystemOneValue,
} from "./decider/systemone.ts";
export { DecisionFailed, OPENROUTER_DECISIONS_URL, SystemOneDecider } from "./decider/systemone.ts";
export type { Profile } from "./profile.ts";
export { DEFAULT_PROFILE } from "./profile.ts";
export { isWeb } from "./reading/state.ts";
export type { ReadingSettings } from "./reading/tree.ts";
export type { CaptchaOutcome, RunInput, RunResult, RunStatus, StepRecord } from "./run/run.ts";

/**
 * How long a page opened by address is given to settle, unless the options say otherwise. Pages that keep loading ads
 * and trackers never go quiet and would use all of it; past this, what is still coming in is read on the next look,
 * as a run's own steps do.
 */
const OPEN_SETTLE_MS = 3_500;
/** How long the document must stay unchanged, and the page's own network quiet, for a settle after an action. */
const SETTLE_QUIET_MS = 200;
const SETTLE_NETWORK_QUIET_MS = 300;
/** The longest the page is given to settle after an action; a page still moving after it is read on the next look. */
const ACTION_SETTLE_MAX_MS = 1_500;
/**
 * How long a step waits for its screenshot once the page is read; one that comes later is waited for after the
 * decision.
 */
const SCREENSHOT_GRACE_MS = 150;
/** How long the page is given to draw what a scroll to a text brought into view (lazy images, sticky headers). */
const REVEAL_SETTLE_MS = 1_000;
/**
 * The widest a screenshot for a person to read is (`readableScreenshot`, a compared page's picture), in pixels: wider
 * than the viewports pages are worked in, so their own pixels are kept; a screen of more pixels (a high-density one) is
 * scaled down to it.
 */
const READABLE_MAX_WIDTH_PX = 1_600;
/** What the settle after an address opened (or a move in the history) is named in the browser's timings. */
const OPEN_KIND = "open";
/** What the settle of a page opened in a background tab to be compared is named in the browser's timings. */
const COMPARE_KIND = "compare";
/**
 * Chrome's codes of the network errors an address is opened again for, as `Page.navigate` says them
 * (`net::ERR_NAME_NOT_RESOLVED`): a connection that failed, a name not found, a time out, a network that changed or
 * went away, a proxy that could not connect.
 */
const NETWORK_ERRORS = [
  "ERR_CONNECTION_",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_TIMED_OUT",
  "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_EMPTY_RESPONSE",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
];
/** How many more times an address the browser could not reach for a network error is opened, and how long after. */
const OPEN_RETRIES = 2;
const OPEN_RETRY_MS = 2_000;
/** The hosts of a browser on this machine. */
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
/** The page a browser with none is given. */
const BLANK_PAGE = "about:blank";
/** The value number a FILL by hand goes by: it is no value of a run's. */
const BY_HAND_VALUE = 0;
/** How many of a dropdown's options a SELECT by hand that fits none of them lists. */
const LISTED_OPTIONS = 30;

/** SCROLL_DOWN or SCROLL_UP, for a scroll by hand. */
function scrollOf(action: { direction: "down" | "up" }): string {
  return action.direction === "up" ? actions.SCROLL_UP : actions.SCROLL_DOWN;
}

/** What an action by hand came to, in words: the operation, its element, and whether it reached the page. */
function describeTaken(taken: Taken): string {
  const on = taken.target ? ` ${taken.target.words}` : "";
  const argument = taken.operation === actions.SELECT && taken.argument ? ` "${taken.argument}"` : "";
  return `${taken.operation}${on}${argument}: ${taken.done ? "done" : "not done"}${taken.note ? ` (${taken.note})` : ""}`;
}

export interface BrowserOptions {
  /**
   * System 1: what answers decision requests, or its System One endpoint. Left out, or for what the options leave out,
   * the endpoint is the one SYSTEM1_URL (default: OpenRouter's decisions endpoint), SYSTEM1_MODEL and
   * SYSTEM1_API_KEY name. SYSTEM1_API_KEY is read only when the options give no `url`: a key from the environment is
   * never sent to an address set in code.
   */
  decider?: Decider | Partial<SystemOneOptions> | undefined;
  /** What the model's requests are written with; left out, the default one with System 1's limits. */
  profile?: Profile | undefined;
  /**
   * The screenshot a step's question carries: made 768 pixels wide by the browser (`scaled`), at the browser's own
   * resolution (`full`), or `none`. Left out: `scaled` for a browser on this machine, `full` for one that runs
   * elsewhere (a hosted browser may crop a picture it is asked to scale: pass `scaled` once you have seen that yours
   * scales).
   */
  screenshot?: "scaled" | "full" | "none" | undefined;
  /**
   * The screenshot a run's step question carries, where it is not as `screenshot` says: `none` asks the decision model
   * in words alone, with all of its budget for them, while `screenshot()` still gives the viewport. Left out: as
   * `screenshot`.
   */
  deciderScreenshot?: "scaled" | "full" | "none" | undefined;
  /**
   * How long a run's step waits for its screenshot once the page is read, in ms: one that comes later is left out and
   * the step asked in words alone, then waited for (up to 3 s from its start) before the step goes on past its
   * decision. 150 ms, left out; pass 3000 to wait for the screenshot (up to 3 s) as before.
   */
  screenshotGraceMs?: number | undefined;
  /**
   * What a settle after an action (a run's step, one by hand, a text shown) and a WAIT's wait for a change count as
   * quiet: the document unchanged this long (200 ms, left out) and the page's own network still this long (300 ms, left
   * out); pass 300 and 500 for the former rules. A page opened's settle goes by the tab's own rules, and its own
   * options.
   */
  settleQuietMs?: number | undefined;
  settleNetworkQuietMs?: number | undefined;
  /**
   * The longest the page is given to settle after an action (a run's step, or one by hand), in ms; 1.5 s, left out
   * (2000 for the former limit).
   */
  actionSettleMaxMs?: number | undefined;
  /**
   * Whether a run's step asks the tab's history where BACK goes while it reads the page, not once it is read (a page
   * that moves on during the read may give another entry); on, left out; `false` asks once it is read.
   */
  backWithRead?: boolean | undefined;
  /**
   * Solves the verification challenge a page shows, when the browser is not solving it itself (Browserbase with captcha
   * solving on is, and SOLVE_CAPTCHA waits for that first); without it SOLVE_CAPTCHA otherwise does nothing.
   */
  solveCaptcha?: ((tab: Tab, signal?: AbortSignal) => Promise<CaptchaOutcome>) | undefined;
  /**
   * The longest a page opened by address (or by a move in the history) is given to settle, in ms; 3.5 s, left out
   * (6000 for the former limit).
   */
  openSettleMs?: number | undefined;
  /** The longest a page compared in a background tab is given to settle, in ms; as `openSettleMs`, left out. */
  compareSettleMs?: number | undefined;
  /** The longest a page is given to settle after a text is scrolled into view, in ms; 1 s, left out. */
  revealSettleMs?: number | undefined;
  /**
   * Whether that settle also ends once the document is complete and has not changed for half a second, whatever
   * requests are still open other than the data and code the page's own frame asked for since it opened
   * (`Tab.settleOpened`); on, left out; `false` for the plain settle.
   */
  fastOpenSettle?: boolean | undefined;
  /**
   * Whether a text `reveal` does not find as it is written is looked for loosely: with punctuation and case folded
   * (its amounts kept whole), then by its amounts with a currency, decimals, a percent sign or a unit alone, never a
   * bare number; the drawn element with the fewest characters that holds it scrolled to (browser/reveal.ts); off, left
   * out.
   */
  revealLoose?: boolean | undefined;
  /**
   * Whether each step a run's onStep hears carries the viewport as `readableScreenshot` gives it, taken while the model
   * decides on the step (StepRecord.readableScreenshot), for whoever watches the task: the model's own screenshot is
   * too small to read with `scaled` (768 pixels wide); off, left out.
   */
  readableStepShots?: boolean | undefined;
  /**
   * Whether a run asks the FILL and SELECT follow-ups of a few boxes and dropdowns in view in the step's own request,
   * so that a step choosing one of them needs no second request (`RunOptions.mergeFollowups`); on, left out; `false`
   * asks them separately, after the step.
   */
  mergeFollowups?: boolean | undefined;
}

/** An action by hand on the page, on an element numbered as the page reads. */
export type ManualAction =
  | { kind: "click"; element: number }
  | { kind: "type"; element: number; text: string; enter: boolean }
  | { kind: "select"; element: number; option: string }
  | { kind: "press_enter"; element: number }
  | { kind: "escape" }
  | { kind: "scroll"; direction: "down" | "up"; element: number | undefined }
  | { kind: "back" };

/** A page compare read: as read_page reads it and its viewport as a JPEG, or why it could not be read. */
export interface ComparedPage {
  /** The address as it was given. */
  url: string;
  page?: { url: string; title: string; lines: string[] } | undefined;
  shot?: Uint8Array | undefined;
  /** What stopped it: it did not open, or could not be read. */
  error?: string | undefined;
}

/** A page as read: its address, its title and its lines. */
export interface PageRead {
  url: string;
  title: string;
  lines: string[];
}

/** What one run may be given besides its goal and values. */
export interface RunControls {
  /** Stops the run from outside. */
  signal?: AbortSignal | undefined;
  /** Hears each step as it is decided. */
  onStep?: ((step: StepRecord) => void) | undefined;
}

/** Whether what a navigation that failed says is a network error (`NETWORK_ERRORS`). */
function networkError(refused: string): boolean {
  return NETWORK_ERRORS.some((code) => refused.includes(code));
}

/** A browser a decision model works: one page at a time, the run following the tabs its actions open. */
export class Browser {
  private readonly connection: Connection;
  private readonly pages: Pages;
  private readonly options: BrowserOptions;
  private readonly chrome: LocalChrome | undefined;

  private constructor(connection: Connection, tab: Tab, options: BrowserOptions, chrome?: LocalChrome) {
    this.connection = connection;
    this.pages = new Pages(connection, tab);
    this.options = options;
    this.chrome = chrome;
  }

  /** Starts a local Chrome and works it. */
  static async launch(options: BrowserOptions & LaunchOptions = {}): Promise<Browser> {
    const chrome = await launchChrome(options);
    try {
      return await Browser.attach(chrome.wsUrl, options, chrome);
    } catch (error) {
      await chrome.close();
      throw error;
    }
  }

  /**
   * Works a browser that is running already, local or hosted, by its DevTools WebSocket address
   * (`ws://…/devtools/browser/…`).
   */
  static connect(wsUrl: string, options: BrowserOptions = {}): Promise<Browser> {
    return Browser.attach(wsUrl, options, undefined);
  }

  private static async attach(
    wsUrl: string,
    options: BrowserOptions,
    chrome: LocalChrome | undefined,
  ): Promise<Browser> {
    const connection = await Connection.connect(wsUrl);
    try {
      // The page to work: one that is a web page or blank; a browser with none (or only its own pages) gets a new one.
      const targets = items(member(await connection.send("Target.getTargets"), "targetInfos"));
      const page = targets.find((target) => {
        const url = string(member(target, "url")) ?? "";
        return member(target, "type") === "page" && (isWeb(url) || url === BLANK_PAGE);
      });
      const targetId =
        string(member(page, "targetId")) ??
        string(member(await connection.send("Target.createTarget", { url: BLANK_PAGE }), "targetId"));
      if (targetId === undefined) throw new Error("the browser gave no page");
      // A browser on this machine scales a screenshot it is asked to; one that runs elsewhere may crop it instead.
      const screenshot =
        options.screenshot ?? (chrome || LOCAL_HOSTS.includes(URL.parse(wsUrl)?.hostname ?? "") ? "scaled" : "full");
      return new Browser(connection, await Tab.attach(connection, targetId), { ...options, screenshot }, chrome);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  /** Whether the connection to the browser has closed. */
  get closed(): boolean {
    return this.connection.closed;
  }

  /** The tab the browser is worked on now. */
  get tab(): Tab {
    return this.pages.current();
  }

  /**
   * Opens an address in the tab and gives the page time to settle. One the browser could not reach for a network error
   * (`NETWORK_ERRORS`) is opened again, `OPEN_RETRIES` more times at most, `OPEN_RETRY_MS` apart; one that does not
   * open fails with what the browser said.
   */
  async open(url: string): Promise<void> {
    await this.reach(url);
    await this.settleOpened();
  }

  /**
   * Opens an address in a tab (the one the browser is worked on, left out), again for a network error, as `open` does;
   * one that does not open fails with what the browser said.
   */
  private async reach(url: string, tab?: Tab): Promise<void> {
    let refused = await this.navigate(url, tab);
    for (let again = 0; refused && networkError(refused) && again < OPEN_RETRIES; again += 1) {
      await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
      refused = await this.navigate(url, tab);
    }
    if (refused) throw new Error(`${url} did not open: ${refused}`);
  }

  /** Gives a page that opened (or a move in the history) time to settle, as the options say (`openSettleMs`). */
  private async settleOpened(tab = this.tab, kind = OPEN_KIND): Promise<void> {
    const maxMs =
      (kind === COMPARE_KIND ? this.options.compareSettleMs : undefined) ?? this.options.openSettleMs ?? OPEN_SETTLE_MS;
    if (this.options.fastOpenSettle ?? true) await tab.settleOpened(maxMs, kind);
    else await tab.settle(maxMs, kind);
  }

  /** Opens an address in a tab: what the browser said of it when it did not open. */
  private async navigate(url: string, tab = this.tab): Promise<string | undefined> {
    return string(member(await tab.send("Page.navigate", { url }), "errorText"));
  }

  /**
   * The page that is open, as the decision model reads it: one line an element, whole. What was typed as a secret
   * reads as dots.
   */
  async read(): Promise<PageRead> {
    return this.readTab(this.tab);
  }

  /** A tab's page as `read` reads it: once the browser's own solving of a verification there, if any, is over. */
  private async readTab(tab: Tab): Promise<PageRead> {
    await tab.browserSolve();
    const capture = await captureTab(tab);
    maskTexts(capture, this.pages.typedTexts());
    const profile = this.options.profile ?? DEFAULT_PROFILE;
    const { tree } = read(capture, { reading: profile.reading, secrets: this.pages.typedSecrets() });
    const lines = writePage(tree, wholeSelection(), new Map(), profile.reading, new Texts(profile.texts)).lines;
    return { url: tree.url, title: tree.title, lines };
  }

  /**
   * Reads each address in a background tab of its own, all at once, and pictures its viewport for a person to read: at
   * the browser's own resolution up to READABLE_MAX_WIDTH_PX wide, not scaled down as the decision model's screenshot
   * is (whole with `screenshot: "full"`, none when screenshots are off). With `lookFor`, each page is first scrolled to
   * those words, as `reveal` scrolls. Each tab opens its page as `open` does (its settle named "compare" in the
   * timings) and is closed again; the tab the browser is worked on is not touched, and is brought to the front again in
   * the end. The pages in the order given, each read or with why it was not.
   */
  async compare(urls: readonly string[], lookFor?: string): Promise<ComparedPage[]> {
    const pages = await Promise.all(urls.map((url) => this.compareOne(url, lookFor)));
    await this.connection.send("Target.activateTarget", { targetId: this.tab.targetId }).catch(() => {});
    return pages;
  }

  /** One address of a compare, in a background tab of its own that is closed again: read, or why it was not. */
  private async compareOne(url: string, lookFor: string | undefined): Promise<ComparedPage> {
    let targetId: string | undefined;
    let tab: Tab | undefined;
    try {
      const made = await this.connection.send("Target.createTarget", { url: BLANK_PAGE, background: true });
      targetId = string(member(made, "targetId"));
      if (targetId === undefined) throw new Error("the browser gave no page");
      tab = await Tab.attach(this.connection, targetId);
      await this.reach(url, tab);
      await this.settleOpened(tab, COMPARE_KIND);
      if (lookFor !== undefined) await this.revealIn(tab, lookFor);
      const [page, shot] = await Promise.all([
        this.readTab(tab),
        this.shotOf(tab, READABLE_MAX_WIDTH_PX).catch(() => undefined),
      ]);
      return { url, page, ...(shot ? { shot } : {}) };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    } finally {
      tab?.close();
      if (targetId !== undefined) await this.connection.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  /** Works a goal on the page that is open, to its result. */
  async run(input: RunInput, controls: RunControls = {}): Promise<RunResult> {
    const screenshot = this.options.deciderScreenshot ?? this.options.screenshot;
    const system1 = system1Of(this.options.decider);
    return run(this.pages, input, {
      profile: profileFor(this.options.profile, system1.limits),
      decider: system1.decider,
      ...(this.options.solveCaptcha ? { solveCaptcha: this.options.solveCaptcha } : {}),
      ...(screenshot ? { screenshot } : {}),
      screenshotGraceMs: this.options.screenshotGraceMs ?? SCREENSHOT_GRACE_MS,
      settling: this.settling(),
      backWithRead: this.options.backWithRead ?? true,
      ...(this.options.readableStepShots ? { readableScreenshot: () => this.readableScreenshot() } : {}),
      mergeFollowups: this.options.mergeFollowups ?? true,
      ...controls,
    });
  }

  /** One action by hand on the page that is open, on an element numbered as `read()` gives it; what came of it. */
  async act(action: ManualAction): Promise<string> {
    const profile = this.options.profile ?? DEFAULT_PROFILE;
    const acting = new Acting(this.tab, new Texts(profile.texts), this.settling());
    const taken = await this.actOn(acting, action, profile);
    await this.pages.adoptOpened();
    return typeof taken === "string" ? taken : describeTaken(taken);
  }

  private async actOn(acting: Acting, action: ManualAction, profile: Profile): Promise<Taken | string> {
    if (action.kind === "escape") return acting.escape();
    if (action.kind === "back") return this.backByHand(acting);
    if (action.kind === "scroll" && action.element === undefined) return acting.scroll(scrollOf(action), undefined);
    const capture = await captureTab(this.tab);
    maskTexts(capture, this.pages.typedTexts());
    const reading = read(capture, { reading: profile.reading, secrets: this.pages.typedSecrets() });
    const number = action.kind === "scroll" ? (action.element ?? 0) : action.element;
    const element = elementOf(reading.tree, number);
    if (!element) return `element ${number} is not on the page as it reads now: read the page again`;
    switch (action.kind) {
      case "click":
        return acting.click(element, () => this.inState(reading.state));
      case "press_enter":
        return acting.pressEnter(element);
      case "scroll":
        return acting.scroll(scrollOf(action), element);
      case "type": {
        const typed = await acting.fill(element, BY_HAND_VALUE, action.text);
        return action.enter && typed.done ? acting.pressEnter(element) : typed;
      }
      case "select": {
        if (element.kind.kind !== "select") return `element ${number} is not a dropdown: click it instead`;
        const wanted = action.option.trim().toLowerCase();
        const options = element.kind.options.filter((option) => !option.disabled);
        const option =
          options.find((each) => each.text.trim().toLowerCase() === wanted) ??
          options.find((each) => each.text.toLowerCase().includes(wanted));
        if (!option) {
          const listed = options.slice(0, LISTED_OPTIONS).map((each) => each.text);
          return `no option of element ${number} reads "${action.option}"; its options: ${listed.join(", ")}`;
        }
        return acting.select(element, option);
      }
    }
  }

  /**
   * Scrolls the first drawn words of the page that hold `text` into view (browser/reveal.ts), loosely as well with
   * `revealLoose`; whether there were any. With `instant` the scroll is done at once, whatever scroll behaviour the
   * page's style gives, so the page is on the text when this returns (a smooth scroll still moves for a while).
   */
  async reveal(text: string, instant = false): Promise<boolean> {
    return this.revealIn(this.tab, text, instant);
  }

  /** `reveal` in a tab. */
  private async revealIn(tab: Tab, text: string, instant = false): Promise<boolean> {
    const script = revealScript(text, this.options.revealLoose === true, instant);
    const found = (await tab.evaluate(script).catch(() => false)) === true;
    if (found)
      await tab.settle(this.options.revealSettleMs ?? REVEAL_SETTLE_MS, undefined, this.settleRules()).catch(() => {});
    return found;
  }

  /** How the page is given time to settle after an action, as the options say. */
  private settling(): Settling {
    return { maxMs: this.options.actionSettleMaxMs ?? ACTION_SETTLE_MAX_MS, rules: this.settleRules() };
  }

  /** What a settle other than a page opened's counts as quiet, as the options say. */
  private settleRules(): SettleRules {
    return {
      quietMs: this.options.settleQuietMs ?? SETTLE_QUIET_MS,
      networkQuietMs: this.options.settleNetworkQuietMs ?? SETTLE_NETWORK_QUIET_MS,
    };
  }

  /** Whether the page reads in the state `state`, as a click that went nowhere leaves it. */
  private async inState(state: string): Promise<boolean> {
    const capture = await captureTab(this.tab).catch(() => undefined);
    if (!capture) return false;
    maskTexts(capture, this.pages.typedTexts());
    const profile = this.options.profile ?? DEFAULT_PROFILE;
    return read(capture, { reading: profile.reading, secrets: this.pages.typedSecrets() }).state === state;
  }

  /** BACK by hand: in the tab's own history, or to the page that opened the tab. */
  private async backByHand(acting: Acting): Promise<Taken | string> {
    const history = (await this.tab.send("Page.getNavigationHistory").catch(() => undefined)) as
      | { currentIndex?: number; entries?: { id?: number }[] }
      | undefined;
    const entry = history?.entries?.[(history.currentIndex ?? 0) - 1]?.id;
    if (entry !== undefined) return acting.back(entry);
    if (!this.pages.canGoBackToOpener()) return "there is no page to go back to";
    await this.pages.backToOpener();
    return "back on the page that opened this tab";
  }

  /** The viewport as a JPEG, as a run's step would show it; none when screenshots are off. */
  async screenshot(): Promise<Uint8Array | undefined> {
    return this.shotOf(this.tab);
  }

  /** A tab's viewport as `screenshot` takes it: at most `maxWidth` pixels wide, unless screenshots are "full". */
  private async shotOf(tab: Tab, maxWidth = SCREENSHOT_MAX_WIDTH_PX): Promise<Uint8Array | undefined> {
    if (this.options.screenshot === "none") return undefined;
    const width = this.options.screenshot === "full" ? undefined : maxWidth;
    return (await tab.viewportJpeg(SCREENSHOT_JPEG_QUALITY, width)).jpeg;
  }

  /**
   * The viewport as a JPEG a person can read (whoever watches a task: the controller's showEvidence, readableStepShots):
   * at the browser's own resolution up to READABLE_MAX_WIDTH_PX wide, whole with `screenshot: "full"` (a browser that
   * crops a picture it is asked to scale); none when screenshots are off.
   */
  async readableScreenshot(): Promise<Uint8Array | undefined> {
    if (this.options.screenshot === "none") return undefined;
    const width = this.options.screenshot === "full" ? undefined : READABLE_MAX_WIDTH_PX;
    return (await this.tab.viewportJpeg(SCREENSHOT_JPEG_QUALITY, width)).jpeg;
  }

  /** Where the browser's time went so far: its settles by what they followed, and its page captures. */
  timings(): TimingsRecord {
    return this.connection.timings.record();
  }

  /** Lets the browser go; one this started is stopped. */
  async close(): Promise<void> {
    this.connection.close();
    await this.chrome?.close();
  }
}
