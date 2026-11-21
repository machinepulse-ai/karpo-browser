/**
 * One browser tab driven over CDP: its out-of-process frames, its network activity, the dialogs it opens, and trusted
 * input (mouse, keyboard) dispatched at the elements the capture found.
 */

import type { Offset } from "../contracts/capture.ts";
import { items, member, number, string } from "../json.ts";
import type { CallOptions, Connection } from "./cdp.ts";
import { CdpError, CdpTimeout } from "./cdp.ts";
import { NATIVE_VALUE_TYPES, nativeValue } from "./native-value.ts";
import type { SliderState, SliderTarget } from "./slider.ts";
import { pressesFor, readSlider, SLIDER_STATE, sameSlider, shown, shownNumber, shows, sliderTarget } from "./slider.ts";

/** A point in the page's viewport (CSS pixels), as input events take it. */
export type Point = Offset;

/** One frame whose document is read on its own: the page itself, or an out-of-process iframe. */
export interface TabFrame {
  /** None for the page's own session. */
  sessionId: string | undefined;
  targetId: string;
  parentSessionId: string | undefined;
}

/**
 * A tab a tab opened: its target, and whether its page can reach the one that opened it (`window.opener`: a sign-in
 * or payment window that answers its opener does; a link's new tab, noopener by default, does not).
 */
export interface OpenedTab {
  targetId: string;
  reachesOpener: boolean;
}

/** Why an input could not go to the element: nothing was sent to the page. */
export type RefusalReason =
  /** Something else takes the click (the detail says what, as the page would describe it). */
  | "covered"
  /** The element is in the document but not drawn. */
  | "hidden"
  /** The page replaced the element since it was read. */
  | "gone"
  /** The element takes no typed value. */
  | "not_a_field"
  /** A select has no such option any more. */
  | "no_option"
  /** The text cannot be read as the native input's value (the detail is the input's type). */
  | "not_a_value";

/** An input that could not go to the element: nothing was sent to the page. */
export class InputRefused extends Error {
  readonly reason: RefusalReason;
  readonly detail: string;

  constructor(reason: RefusalReason, detail = "") {
    super(detail === "" ? reason : `${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * How a settle after an action ended: the page went quiet (document and network), the document went quiet while only
 * the page's own background requests went on, only churn went on, or the time ran out while something was still going
 * on (named by what), or, for a wait for a change, with nothing changed; for a page that opened (`settleOpened`), also
 * its document complete and quiet whatever requests other than its own data and code went on.
 */
export type SettleEnd =
  | "quiet"
  | "document_quiet"
  | "document_complete"
  | "churn_only"
  | "cap_document_changing"
  | "cap_document_loading"
  | "cap_action_requests"
  | "cap_background_requests"
  | "cap_unreadable"
  | "unchanged";

/** What a settle counts as quiet: the document unchanged this long, and the page's own network still this long (ms). */
export interface SettleRules {
  quietMs: number;
  networkQuietMs: number;
}

/** A screenshot: the JPEG, and its size in pixels as the image says. */
export interface Shot {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** The keys `press` sends: the key, its code and its virtual key code; `text` for a key that types. */
const KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, text: undefined },
  Escape: { key: "Escape", code: "Escape", keyCode: 27, text: undefined },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, text: undefined },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, text: undefined },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, text: undefined },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, text: undefined },
} as const;
export type Key = keyof typeof KEYS;

/** Requests that never "finish" in the sense a page load does (streams, pings, media). */
const OPEN_ENDED = ["WebSocket", "EventSource", "Ping", "Media", "Manifest", "CSPViolationReport"];
/** A request older than this is a long poll, not the page still loading. */
const LONG_REQUEST_MS = 5000;
/**
 * Request types that answer an action: a new document, data the page asked for, code it loads to show the answer.
 * Images, fonts, styles and media an action happens to start are decoration: the settle does not wait on them.
 */
const ANSWER_TYPES = ["Document", "XHR", "Fetch", "Script", "Other"];
/** The type a request without one counts as. */
const OTHER_TYPE = "Other";
/** The type of a request that loads a document. */
const DOCUMENT_TYPE = "Document";
/** The protocols of web addresses. */
const WEB_PROTOCOLS = ["http:", "https:"];
/**
 * How long the document must stay unchanged, counted from the start of a settle, for the page to count as settled
 * while requests keep going: a page that polls, tracks or streams in the background never goes quiet on the network.
 */
const DOCUMENT_ONLY_QUIET_MS = 800;
/**
 * A node that changed this many times within the window is churning (an animation, a carousel, a countdown): its
 * further changes are not the page answering an action, unless a change adds elements that carry text.
 */
const CHURN_REPEATS = 3;
const CHURN_WINDOW_MS = 3000;
/** Between keys typed into a control: long enough for a page to move the focus on to its next box. */
const KEY_GAP_MS = 40;
/**
 * How long a slider is given to answer an input, and how often it is read meanwhile: some answer a key only after a
 * frame or two (Element Plus's took over 90 ms on 2026-11-20).
 */
const SLIDER_ANSWER_MS = 400;
const SLIDER_POLL_MS = 30;
/** How long after a slider came to show the value asked it is read once more: a page may still be moving it. */
const SLIDER_CONFIRM_MS = 150;
/** The most positions a slider is stepped through looking for the words asked, and the most keys toward a number. */
const SLIDER_MAX_STEPS = 120;
const SLIDER_MAX_KEYS = 300;
/** The longest run of keys toward a number before the slider is read again. */
const SLIDER_KEY_RUN = 10;
/** The modifier the select-all key press carries (Ctrl); the `selectAll` editing command does the work. */
const SELECT_ALL_MODIFIER = 2;
/** How long a settle waits between reads of the page. */
const SETTLE_POLL_MS = 100;
/** How long a settle waits for the document to stop changing, and for the network to stop. */
const SETTLE_QUIET_MS = 300;
const SETTLE_NETWORK_QUIET_MS = 500;
/** The rules a settle goes by unless its caller gives others; a page opened's settle always goes by these. */
export const SETTLE_RULES: Readonly<SettleRules> = {
  quietMs: SETTLE_QUIET_MS,
  networkQuietMs: SETTLE_NETWORK_QUIET_MS,
};
/**
 * How long the document of a page that opened must stay unchanged, counted from the start of the settle at the
 * earliest, once it is complete, for the page to count as settled whatever other requests are still open.
 */
const OPEN_QUIET_MS = 500;
/**
 * The requests of the page's own frame that bring what it shows (data it asked for, code that draws it: a search page's
 * results come by either): one sent since the page opened is waited for even by its quicker settle.
 */
const OPEN_DATA_TYPES = ["XHR", "Fetch", "Script"];
/** What a settle followed, as the browser's timings name it: a settle by itself, an action, a wait for a change. */
const SETTLE_KIND = "settle";
const ACTION_KIND = "action";
const WAIT_KIND = "wait";
/** The CDP domain of what a person does: a command in it is input reaching the page. */
const INPUT_DOMAIN = "Input.";
/** How long a click waits after centring a covered element before looking again. */
const RECENTRE_WAIT_MS = 150;
/** How long the mouse button stays down in a click. */
const PRESS_HOLD_MS = 30;
/** How many of the tab's latest requests are kept. */
const REQUEST_LOG_SIZE = 500;
/** The dialogs accepted as they open: they ask nothing. A confirm or a prompt is declined. */
const ACCEPTED_DIALOGS = ["alert", "beforeunload"];
/** The grid inside a box a click is tested on, and the ring near its edges, as fractions of its width and height. */
const PROBE_INNER = [0.25, 0.5, 0.75];
const PROBE_RING = [0.1, 0.25, 0.5, 0.75, 0.9];
const PROBE_CENTRE = 0.5;
const PROBE_EDGES = [0.1, 0.9];

/**
 * Where a control is tested for what a click there would land on, as fractions of its box: the centre first, then a
 * grid across it, then a ring near its edges. A control a fixed layer covers in part is still found where it shows.
 */
export const CLICK_PROBE_FRACTIONS: readonly (readonly [number, number])[] = [
  [PROBE_CENTRE, PROBE_CENTRE],
  ...PROBE_INNER.flatMap((fx) => PROBE_INNER.map((fy) => [fx, fy] as const)).filter(
    ([fx, fy]) => fx !== PROBE_CENTRE || fy !== PROBE_CENTRE,
  ),
  ...PROBE_RING.flatMap((fx) => PROBE_RING.map((fy) => [fx, fy] as const)).filter(
    ([fx, fy]) => PROBE_EDGES.includes(fx) || PROBE_EDGES.includes(fy),
  ),
];

/**
 * Read by `settle`: when the document last changed. A MutationObserver only watches; nothing on the page
 * (prototypes, timers, listeners) is replaced.
 */
const WATCH_SCRIPT = `(() => {
  if (window.__settleWatch) return;
  const state = { changedAt: Date.now(), steadyAt: Date.now() };
  const recent = new WeakMap();
  const churning = (target, now) => {
    const times = (recent.get(target) || []).filter((at) => now - at < ${CHURN_WINDOW_MS});
    times.push(now);
    recent.set(target, times);
    return times.length >= ${CHURN_REPEATS};
  };
  const addsText = (r) => [...r.addedNodes].some((n) => n.nodeType === 1 && (n.textContent || "").trim().length > 0);
  Object.defineProperty(window, "__settleWatch", { value: state });
  new MutationObserver((records) => {
    const now = Date.now();
    state.changedAt = now;
    for (const r of records) if (!churning(r.target, now) || addsText(r)) state.steadyAt = now;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})()`;
/**
 * The page's state for `settle`: its ready state, and how long since its document last changed, and since it last
 * changed other than by churn.
 */
const SETTLE_READ = `(() => { const w = window.__settleWatch, now = Date.now(); return { ready: document.readyState, quiet: w ? now - w.changedAt : 1e9, steady: w ? now - (w.steadyAt || w.changedAt) : 1e9 }; })()`;
/** Whether the element is still in its document. */
const IS_CONNECTED = "function () { return this.isConnected; }";
/** What a click at each point would land on, from the element's own document. */
const HITS_AT = `function (points, border) {
  const root = this.getRootNode && this.getRootNode().elementFromPoint ? this.getRootNode() : document;
  const own = this.getBoundingClientRect();
  const dx = border ? border.x - own.left : 0, dy = border ? border.y - own.top : 0;
  return points.map((p) => {
    const at = root.elementFromPoint(p.x - dx, p.y - dy);
    // The control itself, anything inside it, its label, or the input its label stands for: a styled radio or
    // checkbox often draws its input over the label, and a click there is the click wanted.
    const labelled = (a, b) => !!(a.labels && [...a.labels].some((l) => l === b || l.contains(b) || b.contains(l)));
    // A field drawn fully transparent over the control (code boxes over a hidden input) is not what a person sees:
    // their click lands on it, and that is the click wanted.
    const clickTypes = ["checkbox", "radio", "submit", "button", "reset", "image", "range", "color", "file", "hidden"];
    const editable = (e) => e.isContentEditable || e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && clickTypes.indexOf((e.type || "").toLowerCase()) < 0);
    const transparent = (e) => { for (let a = e; a && a.nodeType === 1; a = a.parentElement) if (Number(getComputedStyle(a).opacity) < 0.05) return true; return false; };
    const ok = !!at && (at === this || this.contains(at) || labelled(this, at) || labelled(at, this) || (editable(at) && transparent(at)));
    if (ok || !at) return { ok, by: "" };
    const words = (at.innerText || at.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 40).replace(/[\\uD800-\\uDBFF]$/, "");
    const role = at.getAttribute("role");
    return { ok, by: at.tagName.toLowerCase() + (role ? "[role=" + role + "]" : "") + (words ? ' "' + words + '"' : "") };
  });
}`;
/** The label of a checkbox or radio, scrolled into view. */
const LABEL_OF = `function () {
  const label = (this.labels && this.labels[0]) || (this.closest && this.closest("label"));
  if (!label) return null;
  label.scrollIntoView({ block: "center" });
  return label;
}`;
/** Scrolls the element to the middle of the viewport. */
const SCROLL_TO_CENTRE = `function () { this.scrollIntoView({ block: "center", inline: "center" }); }`;
const FOCUS = "function () { this.focus(); }";
/** The type of an input that takes a value, or "". */
const INPUT_TYPE =
  "function () { return this instanceof HTMLInputElement && !this.readOnly && !this.disabled ? this.type : ''; }";
/** Whether the element takes typed text; what it holds is selected so typing replaces it. */
const SELECT_HELD = `function () {
  const field = this.isContentEditable || ("value" in this && !this.readOnly && !this.disabled);
  if (!field) return false;
  const had = "value" in this ? this.value : this.textContent;
  if (had) {
    if (typeof this.select === "function") this.select();
    else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  return true;
}`;
/** The value of the field that has the focus, through open shadow roots and same-origin frames. */
const FOCUSED_VALUE = `(() => {
  let a = document.activeElement;
  for (let hops = 0; a && hops < 10; hops++) {
    if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    if (a.tagName === "IFRAME") { try { const d = a.contentDocument; if (d && d.activeElement) { a = d.activeElement; continue; } } catch (e) {} }
    break;
  }
  if (!a) return null;
  if (a.tagName === "INPUT" || a.tagName === "TEXTAREA") return String(a.value);
  if (a.isContentEditable) return a.textContent || "";
  return null;
})()`;
/** Sets a native control's value through its prototype's setter, then fires input and change. */
const SET_VALUE = `function (value) {
  const proto = this instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value").set;
  set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`;
/** The field's value now. */
const VALUE_NOW = `function () { return String("value" in this ? this.value : this.textContent || ""); }`;
/**
 * A native select's option by its live index, when its text is still `text` (white space collapsed): chosen as the
 * browser's own control chooses it, the page hearing input and change. False when the option is not there.
 */
const PICK_INDEX = `function (index, text) {
  const option = this instanceof HTMLSelectElement ? this.options[index] : null;
  if (!option || option.textContent.replace(/\\s+/g, " ").trim() !== text) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex").set.call(this, index);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;
/** Scrolls a box's content by most of its height; whether it moved. */
const SCROLL_BOX = `function (direction) { const before = this.scrollTop; this.scrollBy({ top: Math.sign(direction) * Math.max(40, Math.round(this.clientHeight * 0.8)), behavior: "instant" }); return this.scrollTop !== before; }`;

/** A request the tab sent: its resource type, and what document it belongs to. */
interface LoggedRequest {
  type: string | undefined;
  sessionId: string;
  loaderId: string | undefined;
  frameId: string | undefined;
  ended: boolean;
}

/** `quads.find(...)`: the first quad with an area above one pixel. */
function drawnQuad(quads: readonly unknown[]): readonly number[] | undefined {
  for (const quad of quads) {
    const at = (i: number) => number(items(quad)[i]) ?? 0;
    if (Math.abs((at(2) - at(0)) * (at(5) - at(1))) > 1) return [0, 1, 2, 3, 4, 5, 6, 7].map(at);
  }
  return undefined;
}

/** A JPEG's width and height, from its frame header; undefined when it has none. */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number } | undefined {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  const word = (from: number) => ((jpeg[from] ?? 0) << 8) | (jpeg[from + 1] ?? 0);
  for (let at = 2; at + 9 < jpeg.length; ) {
    while (jpeg[at] === 0xff && jpeg[at + 1] === 0xff) at += 1;
    const marker = jpeg[at + 1] ?? 0;
    if (jpeg[at] !== 0xff) return undefined;
    // A frame header: SOF0 to SOF15, but the tables that share their range (DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: word(at + 7), height: word(at + 5) };
    }
    at += 2 + word(at + 2);
  }
  return undefined;
}

export class Tab {
  readonly targetId: string;
  /** The page's own session. */
  readonly sessionId: string;
  private readonly connection: Connection;
  private readonly off: () => void;
  /** The page went away (closed, or its session detached). */
  private isGone = false;
  /** Its page's renderer crashed and the page has not been reloaded since: it answers no command meanwhile. */
  private isCrashed = false;
  /** Its page's address, as the browser last told it. */
  private address = "";
  private readonly children = new Map<string, TabFrame>();
  /** The requests still open, with when each began. */
  private readonly inflight = new Map<string, number>();
  private readonly requests = new Map<string, LoggedRequest>();
  /** Which open requests load a document (a page or a frame): never background traffic. */
  private readonly documentRequests = new Set<string>();
  private lastNetwork = Date.now();
  /**
   * The open requests of the page's out-of-process frames (ads, trackers, embeds), which a settle does not wait on,
   * and when the page's own network last moved.
   */
  private readonly childRequests = new Set<string>();
  private lastPageNetwork = Date.now();
  /** When input was last sent to the page: what an action's settle counts the quiet from. */
  private lastInput = 0;
  /** The tabs this tab opened. */
  private readonly opened = new Map<string, OpenedTab>();

  private constructor(connection: Connection, targetId: string, sessionId: string) {
    this.connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.off = connection.on((method, params, session) => this.handle(method, params, session));
  }

  /** Attaches to the page target and to every out-of-process frame it has or gets. */
  static async attach(connection: Connection, targetId: string): Promise<Tab> {
    const answer = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(connection, targetId, string(member(answer, "sessionId")) ?? "");
    try {
      // The browser tells of every tab it already has as it starts telling of new ones: those were open before,
      // none of them is one an action of the run opened.
      const discovering = connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      const info = connection.send("Target.getTargetInfo", { targetId }).catch(() => undefined);
      await tab.prepare(tab.sessionId, true);
      await discovering;
      tab.opened.clear();
      if (tab.address === "") tab.address = string(member(member(await info, "targetInfo"), "url")) ?? "";
      return tab;
    } catch (error) {
      tab.close();
      throw error;
    }
  }

  /** Whether the page went away: closed, or its session detached. */
  get gone(): boolean {
    return this.isGone;
  }

  get crashed(): boolean {
    return this.isCrashed;
  }

  /** The page's address, as the browser last told it. */
  get url(): string {
    return this.address;
  }

  /** The tabs this tab opened since they were last taken. */
  takeOpened(): OpenedTab[] {
    const opened = [...this.opened.values()];
    this.opened.clear();
    return opened;
  }

  /** Whether this tab opened a tab since they were last taken. */
  hasOpened(): boolean {
    return this.opened.size > 0;
  }

  /** Lets the tab go: its events are heard no more and its session ends (the page itself stays open). */
  close(): void {
    this.off();
    if (!this.isGone) this.connection.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
  }

  /** One command on a session of the tab (the page's own when none). */
  send(method: string, params: object = {}, sessionId?: string, options?: CallOptions): Promise<unknown> {
    if (method.startsWith(INPUT_DOMAIN)) this.lastInput = Date.now();
    return this.connection.send(method, params, sessionId ?? this.sessionId, options);
  }

  /** The page first, then its out-of-process frames; same-process iframes are part of the page's document. */
  frames(): TabFrame[] {
    return [{ sessionId: undefined, targetId: this.targetId, parentSessionId: undefined }, ...this.children.values()];
  }

  /** Where an out-of-process frame's viewport sits in the page's viewport. */
  async frameOffset(frame: TabFrame): Promise<Point> {
    if (frame.sessionId === undefined) return { x: 0, y: 0 };
    const frames = this.frames();
    const parent = frames.find((candidate) => candidate.sessionId === frame.parentSessionId) ?? frames[0]!;
    const above = await this.frameOffset(parent);
    const session = frame.parentSessionId ?? this.sessionId;
    const owner = await this.send("DOM.getFrameOwner", { frameId: frame.targetId }, session);
    const answer = await this.send("DOM.getBoxModel", { backendNodeId: member(owner, "backendNodeId") }, session);
    const content = items(member(member(answer, "model"), "content"));
    return { x: above.x + (number(content[0]) ?? 0), y: above.y + (number(content[1]) ?? 0) };
  }

  /**
   * Runs an expression in a session's document (the page's own when none) and returns its JSON value; an expression
   * that throws fails with what it threw.
   */
  async evaluate(expression: string, sessionId?: string): Promise<unknown> {
    const answer = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    const thrown = member(answer, "exceptionDetails");
    if (thrown) {
      const said = member(member(thrown, "exception"), "description") ?? member(thrown, "text");
      throw new Error(said === undefined || said === null ? "evaluation failed" : String(said));
    }
    return member(member(answer, "result"), "value");
  }

  /** Runs a function with the element as `this`; its JSON result comes back. */
  async on(
    backendNodeId: number,
    sessionId: string,
    declaration: string,
    args: readonly unknown[] = [],
  ): Promise<unknown> {
    const objectId = await this.objectOf(backendNodeId, sessionId);
    const answer = await this.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: declaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    const thrown = member(answer, "exceptionDetails");
    if (thrown) throw new Error(string(member(thrown, "text")) ?? "call failed");
    return member(member(answer, "result"), "value");
  }

  /**
   * Until the document has not changed for a while and no request is open; or, while only the page's own background
   * requests keep going, until the document has not changed (or has changed only by churn) for longer; or until
   * `maxMs` passed. How it ended: settled, or what was still going on when the time ran out. Quiet is as `rules` say.
   */
  settle(maxMs: number, kind = SETTLE_KIND, rules: Readonly<SettleRules> = SETTLE_RULES): Promise<SettleEnd> {
    return this.settleSince(Date.now(), maxMs, false, kind, false, rules);
  }

  /**
   * A settle after an action that began at `since` (epoch ms): the requests the action itself started count as its
   * answer and are waited for, as they are not when the settle is counted from its own start.
   */
  settleAfter(since: number, maxMs: number, rules: Readonly<SettleRules> = SETTLE_RULES): Promise<SettleEnd> {
    return this.settleSince(since, maxMs, false, ACTION_KIND, false, rules);
  }

  /**
   * A settle after a page opened (or a move in the history): as `settle`, or, sooner, once the document is complete and
   * has not changed for `OPEN_QUIET_MS`, whatever other requests are still open (ads, trackers and polls keep some open
   * long after the page is drawn): not while a new document is loading in the page's own frame, nor while data or code
   * that frame asked for since the settle began is (`OPEN_DATA_TYPES`).
   */
  settleOpened(maxMs: number, kind = SETTLE_KIND): Promise<SettleEnd> {
    return this.settleSince(Date.now(), maxMs, false, kind, true);
  }

  /** The time a capture of the page took, for the browser's timings. */
  noteCapture(ms: number): void {
    this.connection.timings.captured(ms);
  }

  /**
   * A settle for an action that began at `since` (epoch ms), before this settle: the requests started since then
   * count as the action's and, with `quietFromSince`, the document's quiet is counted from then too (from the last
   * input sent to the page, when that came later), so a change the action sets off late is waited for. Only the
   * page's own requests count: its out-of-process frames' (ads, trackers, embeds) are not waited on.
   */
  private async settleSince(
    since: number,
    maxMs: number,
    quietFromSince: boolean,
    kind: string,
    opened = false,
    rules: Readonly<SettleRules> = SETTLE_RULES,
  ): Promise<SettleEnd> {
    const started = Date.now();
    const end = await this.settleFrom(since, maxMs, quietFromSince, started, opened, rules);
    this.connection.timings.settled(kind, Date.now() - started, end);
    return end;
  }

  private async settleFrom(
    since: number,
    maxMs: number,
    quietFromSince: boolean,
    started: number,
    opened: boolean,
    rules: Readonly<SettleRules>,
  ): Promise<SettleEnd> {
    let going: SettleEnd = "cap_unreadable";
    while (Date.now() - started < maxMs) {
      const page = await this.settleRead(started + maxMs);
      const now = Date.now();
      for (const [id, opened] of this.inflight) {
        if (now - opened <= LONG_REQUEST_MS) continue;
        this.inflight.delete(id);
        this.childRequests.delete(id);
      }
      const pageOpen = [...this.inflight].filter(([id]) => !this.childRequests.has(id));
      const network = pageOpen.length === 0 && now - this.lastPageNetwork >= rules.networkQuietMs;
      if (!page) going = "cap_unreadable";
      else if (page.ready === "loading") going = "cap_document_loading";
      else {
        const from = Math.max(since, this.lastInput);
        const quiet = quietFromSince ? Math.min(page.quiet, now - from) : page.quiet;
        const steady = quietFromSince ? Math.min(page.steady, now - from) : page.steady;
        if (quiet >= rules.quietMs && network) return "quiet";
        if (
          opened &&
          page.ready === "complete" &&
          Math.min(quiet, now - since) >= OPEN_QUIET_MS &&
          !this.pageDocumentLoading() &&
          !pageOpen.some(([id, began]) => began >= since && this.pageData(id))
        ) {
          return "document_complete";
        }
        // Only while the requests still open were open before the action (the page's own background), so a
        // submit's or a save's answer is waited for.
        const sinceAction = pageOpen.some(
          ([id, opened]) => opened >= since && ANSWER_TYPES.includes(this.requests.get(id)?.type ?? OTHER_TYPE),
        );
        const loading = this.documentLoading();
        if (!sinceAction && !loading && Math.min(quiet, now - since) >= DOCUMENT_ONLY_QUIET_MS) return "document_quiet";
        if (!sinceAction && !loading && Math.min(steady, now - since) >= DOCUMENT_ONLY_QUIET_MS) return "churn_only";
        if (quiet < rules.quietMs) going = "cap_document_changing";
        else if (loading) going = "cap_document_loading";
        else going = sinceAction ? "cap_action_requests" : "cap_background_requests";
      }
      await this.connection.wait(SETTLE_POLL_MS);
    }
    return going;
  }

  /**
   * Until the page changes other than by churn (or loads a document) after `since` and then settles, by `until` (both
   * epoch ms), quiet as `rules` say: how the settle ended, or "unchanged" when nothing changed in time.
   */
  async changed(since: number, until: number, rules: Readonly<SettleRules> = SETTLE_RULES): Promise<SettleEnd> {
    while (Date.now() < until) {
      const page = await this.settleRead(until);
      const now = Date.now();
      if (page && (page.ready === "loading" || page.steady < now - since))
        return this.settleSince(since, until - now, false, WAIT_KIND, false, rules);
      await this.connection.wait(Math.max(Math.min(SETTLE_POLL_MS, until - now), 0));
    }
    return "unchanged";
  }

  /** A left click where the element receives it: scrolled into view, and centred once more if something covers it. */
  async click(backendNodeId: number, sessionId: string): Promise<void> {
    await this.scrollIntoView(backendNodeId, sessionId).catch(() => {});
    let point: Point;
    try {
      point = await this.reachablePoint(backendNodeId, sessionId);
    } catch (error) {
      // The visible label stands in for a hidden checkbox or radio (styled controls hide the input).
      const label =
        error instanceof InputRefused && error.reason === "hidden"
          ? await this.labelPoint(backendNodeId, sessionId)
          : undefined;
      if (!label) throw error;
      point = label;
    }
    await this.mouseClick(point);
  }

  /** A left click at a point of the page's viewport: moved there, pressed, held a moment, released. */
  async mouseClick({ x, y }: Point): Promise<void> {
    const pressed = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { ...pressed, type: "mousePressed", buttons: 1 });
    await this.connection.wait(PRESS_HOLD_MS);
    await this.send("Input.dispatchMouseEvent", { ...pressed, type: "mouseReleased", buttons: 0 });
  }

  /**
   * Replaces a field's value: click into it, then type the text; a native typed input (date, time, number…) takes
   * its standard value through the element instead, since its segments are the browser's own. Returns the value the
   * field should now hold.
   */
  async fill(backendNodeId: number, sessionId: string, text: string): Promise<string> {
    // A field the pointer cannot reach (covered, not drawn, gone) is not typed into from behind: a person could not
    // either. A click the page did not answer in time may have reached it: nothing more is typed on top of it.
    try {
      await this.click(backendNodeId, sessionId);
    } catch (error) {
      if (error instanceof InputRefused || error instanceof CdpTimeout) throw error;
    }
    await this.focus(backendNodeId, sessionId);
    const type = await this.on(backendNodeId, sessionId, INPUT_TYPE).catch(() => undefined);
    if (typeof type === "string" && NATIVE_VALUE_TYPES.includes(type)) {
      const value = nativeValue(type, text);
      if (value === undefined) throw new InputRefused("not_a_value", type);
      await this.on(backendNodeId, sessionId, SET_VALUE, [value]);
      return value;
    }
    if (!(await this.on(backendNodeId, sessionId, SELECT_HELD))) throw new InputRefused("not_a_field");
    await this.press("Backspace");
    if (text !== "") await this.send("Input.insertText", { text });
    return text;
  }

  /** The slider an element is and what it holds now; undefined when it is no slider or is gone. */
  async sliderState(backendNodeId: number, sessionId: string): Promise<SliderState | undefined> {
    return readSlider(await this.on(backendNodeId, sessionId, SLIDER_STATE).catch(() => undefined));
  }

  /** Whether a slider shows the value a task's text asks, and what it shows; undefined when it is gone. */
  async sliderShows(
    backendNodeId: number,
    sessionId: string,
    text: string,
  ): Promise<{ set: boolean; shown: string } | undefined> {
    const now = await this.sliderState(backendNodeId, sessionId);
    return now ? { set: shows(now, sliderTarget(text)), shown: shown(now) } : undefined;
  }

  /**
   * Sets a slider to the value a task's text asks, by what the slider shows (`slider.ts`), without a click (a click
   * moves it): a native range takes a number through the element, as the browser's own control does; any slider not
   * showing the value then is moved by keys, as a person with a keyboard moves it, toward the number when it shows
   * numbers, else a position at a time until it shows the words asked. One that does not come to show the value is
   * put back where it was. Whether it shows the value now, and what it shows.
   */
  async setSlider(backendNodeId: number, sessionId: string, text: string): Promise<{ set: boolean; shown: string }> {
    const start = await this.sliderState(backendNodeId, sessionId);
    if (!start || start.disabled) throw new InputRefused("not_a_field");
    const target = sliderTarget(text);
    if (shows(start, target)) return { set: true, shown: shown(start) };
    const read = (before: SliderState) => this.sliderAfter(backendNodeId, sessionId, before);
    const setValue = async (value: string, before: SliderState) => {
      await this.on(backendNodeId, sessionId, SET_VALUE, [value]);
      return read(before);
    };
    let now = start;
    if (start.native && target.number !== undefined) {
      now = await setValue(String(target.number), start);
      if (!shows(now, target) && !sameSlider(now, start)) now = await setValue(start.value, now);
    }
    // Keys reach a slider that has the focus alone: sent without it they would move whatever has it.
    await this.focus(backendNodeId, sessionId).catch(() => {});
    const keys: readonly [Key, Key] = start.vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowRight", "ArrowLeft"];
    const keyed = !shows(now, target) && (await this.sliderState(backendNodeId, sessionId))?.focused === true;
    if (keyed) {
      // A native range that shows its own value took the number above or cannot hold it: keys would not reach it.
      const own = start.native && shownNumber(start) === Number(start.value);
      if (target.number === undefined || shownNumber(now) === undefined) {
        now = await this.keysToWords(target, now, keys, read);
      } else if (!own) {
        now = await this.keysToNumber(target.number, now, keys, read);
      }
    }
    if (shows(now, target)) {
      await this.connection.wait(SLIDER_CONFIRM_MS);
      now = (await this.sliderState(backendNodeId, sessionId)) ?? now;
      if (shows(now, target)) return { set: true, shown: shown(now) };
    }
    // Not the value asked: back where it was (the words' search ends there by itself).
    const startNumber = shownNumber(start);
    if (start.native) {
      if (!sameSlider(now, start)) now = await setValue(start.value, now);
    } else if (keyed && startNumber !== undefined) {
      now = await this.keysToNumber(startNumber, now, keys, read);
    }
    return { set: false, shown: shown(now) };
  }

  /**
   * What a slider holds once it has answered an input: read until it differs from `before` and two reads agree, for
   * `SLIDER_ANSWER_MS` at most; `before` itself when it never answered.
   */
  private async sliderAfter(backendNodeId: number, sessionId: string, before: SliderState): Promise<SliderState> {
    const until = Date.now() + SLIDER_ANSWER_MS;
    let last = before;
    for (;;) {
      await this.connection.wait(SLIDER_POLL_MS);
      const now = (await this.sliderState(backendNodeId, sessionId)) ?? last;
      if (!sameSlider(now, before) && sameSlider(now, last)) return now;
      if (Date.now() >= until) return now;
      last = now;
    }
  }

  /**
   * Moves a slider that shows numbers toward a number by keys: one press toward it tells which way a key moves it (a
   * page laid out right to left turns the arrows round) and how far; then runs of presses, read after each. A run
   * that did not move it as far as its presses should have (steps of uneven size, or a page that takes quick presses
   * for one) is followed by single presses, each read, which stop where the slider passes the number without holding
   * it. What it holds then.
   */
  private async keysToNumber(
    wanted: number,
    from: SliderState,
    [up, down]: readonly [Key, Key],
    read: (before: SliderState) => Promise<SliderState>,
  ): Promise<SliderState> {
    const at = shownNumber(from);
    if (at === undefined || at === wanted) return from;
    const first = wanted > at ? up : down;
    await this.press(first);
    let now = await read(from);
    const moved = (shownNumber(now) ?? at) - at;
    if (moved === 0) return now;
    const [more, less] = moved > 0 === (first === up) ? [up, down] : [down, up];
    const step = Math.abs(moved);
    let single = false;
    for (let presses = 1; presses < SLIDER_MAX_KEYS; ) {
      const here = shownNumber(now);
      if (here === undefined || here === wanted) break;
      const gap = wanted - here;
      // Within half a step of the number without holding it: the steps may be finer here, so single presses go on.
      const run: number =
        (single ? 0 : pressesFor(gap, step, Math.min(SLIDER_KEY_RUN, SLIDER_MAX_KEYS - presses))) || 1;
      single ||= run === 1;
      for (let n = 0; n < run; n++) await this.press(gap > 0 ? more : less);
      presses += run;
      const after = await read(now);
      const there = shownNumber(after);
      if (sameSlider(after, now) || there === undefined) break;
      now = after;
      const passed = there !== wanted && there > wanted !== here > wanted;
      if (single && passed) break;
      if (passed || Math.abs(Math.abs(there - here) - run * step) > step / 2) single = true;
    }
    return now;
  }

  /**
   * Steps a slider a position at a time until it shows the words asked: up from where it is, then down, back where
   * it started between the two and when neither way shows them (`SLIDER_MAX_STEPS` positions at most). What it holds
   * then.
   */
  private async keysToWords(
    target: SliderTarget,
    from: SliderState,
    [up, down]: readonly [Key, Key],
    read: (before: SliderState) => Promise<SliderState>,
  ): Promise<SliderState> {
    let now = from;
    let steps = 0;
    for (const [key, back] of [
      [up, down],
      [down, up],
    ] as const) {
      let moved = 0;
      while (steps < SLIDER_MAX_STEPS) {
        await this.press(key);
        const after = await read(now);
        if (sameSlider(after, now)) break;
        now = after;
        moved += 1;
        steps += 1;
        if (shows(now, target)) return now;
      }
      // Back a position at a time, each read: a page may take quick presses for one.
      for (let n = 0; n < moved && !sameSlider(now, from); n++) {
        await this.press(back);
        const after = await read(now);
        if (sameSlider(after, now)) break;
        now = after;
      }
    }
    return now;
  }

  /** Types into a field key by key, what it holds cleared first. */
  async typeKeys(backendNodeId: number, sessionId: string, text: string): Promise<void> {
    await this.focus(backendNodeId, sessionId);
    const answer = await this.send("Runtime.evaluate", { returnByValue: true, expression: FOCUSED_VALUE }, sessionId);
    if (string(member(member(answer, "result"), "value"))) {
      await this.selectAll();
      await this.press("Backspace");
    }
    for (const character of text) {
      await this.typeCharacter(character);
      await this.connection.wait(KEY_GAP_MS);
    }
  }

  /** The field's value now (a controlled component may have rewritten it); undefined when it is gone. */
  async valueOf(backendNodeId: number, sessionId: string): Promise<string | undefined> {
    return string(await this.on(backendNodeId, sessionId, VALUE_NOW).catch(() => undefined));
  }

  /** One key press to whatever has the focus. */
  async press(key: Key): Promise<void> {
    const spec = KEYS[key];
    const common = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    };
    const down = spec.text === undefined ? { type: "rawKeyDown" } : { type: "keyDown", text: spec.text };
    await this.send("Input.dispatchKeyEvent", { ...common, ...down });
    await this.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  }

  /**
   * Chooses a native select's option by its live index after checking the option still says `text`; refused when the
   * dropdown cannot be reached (covered, not drawn), as a click would be, or its options changed while deciding.
   */
  async selectIndex(backendNodeId: number, sessionId: string, index: number, text: string): Promise<void> {
    await this.scrollIntoView(backendNodeId, sessionId).catch(() => {});
    await this.reachablePoint(backendNodeId, sessionId);
    if ((await this.on(backendNodeId, sessionId, PICK_INDEX, [index, text])) !== true)
      throw new InputRefused("no_option");
  }

  /** Scrolls the page itself; whether it moved. */
  async scroll(deltaY: number): Promise<boolean> {
    const expression = `(() => { const before = scrollY; scrollBy({ top: ${Math.trunc(deltaY)}, behavior: "instant" }); return scrollY !== before; })()`;
    return Boolean(await this.evaluate(expression));
  }

  /** Scrolls a box's own content by most of its height, in the direction of `deltaY`; whether it moved. */
  async scrollBox(backendNodeId: number, sessionId: string, deltaY: number): Promise<boolean> {
    return Boolean(await this.on(backendNodeId, sessionId, SCROLL_BOX, [deltaY]));
  }

  /**
   * The viewport as a person sees it, a JPEG at `quality`: with `maxWidth`, made that many pixels wide by the browser
   * where the viewport is wider (never scaled up); without, at the browser's own resolution. A hosted browser may crop
   * a picture it is asked to scale, so the width is asked for only where the browser is known to scale.
   */
  async viewportJpeg(quality: number, maxWidth?: number): Promise<Shot> {
    const metrics = await this.send("Page.getLayoutMetrics");
    const view = member(metrics, "cssVisualViewport");
    const width = number(member(view, "clientWidth"));
    if (width === undefined) throw new Error("the page gives no viewport");
    const device = number(member(member(metrics, "visualViewport"), "clientWidth")) ?? 0;
    const pixels = width * (device > 0 && width > 0 ? device / width : 1);
    const clip = {
      x: number(member(view, "pageX")) ?? 0,
      y: number(member(view, "pageY")) ?? 0,
      width,
      height: number(member(view, "clientHeight")) ?? 0,
    };
    const scale = maxWidth !== undefined && pixels > maxWidth ? maxWidth / pixels : 1;
    const answer = await this.send("Page.captureScreenshot", { format: "jpeg", quality, clip: { ...clip, scale } });
    const jpeg = Buffer.from(string(member(answer, "data")) ?? "", "base64");
    const size = jpegSize(jpeg);
    if (!size) throw new Error("the page gave no screenshot");
    return { jpeg, ...size };
  }

  /** The commands a session is prepared with. */
  private async prepare(sessionId: string, page: boolean): Promise<void> {
    const send = (method: string, params: object = {}) => this.send(method, params, sessionId);
    // Sent together: a session handles its commands in the order they arrive, so nothing waits a round trip on the
    // one before (each is one to a browser that may be remote).
    const needed = [send("Runtime.enable"), send("Page.enable"), send("DOM.enable")];
    const optional = [
      send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
      send("Accessibility.enable"),
      send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH_SCRIPT }),
      send("Runtime.evaluate", { expression: WATCH_SCRIPT }),
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
      // A background tab reports no focus; typing needs it, as a visible tab would have.
      ...(page ? [send("Emulation.setFocusEmulationEnabled", { enabled: true })] : []),
    ];
    await Promise.all([Promise.all(needed), Promise.allSettled(optional)]);
  }

  private handle(method: string, params: unknown, sessionId: string | undefined): void {
    const text = (key: string) => string(member(params, key));
    if (method === "Target.targetDestroyed") {
      if (text("targetId") === this.targetId) this.isGone = true;
      // A tab that opened and closed again (a download, a tracker) is none to go on in.
      this.opened.delete(text("targetId") ?? "");
    }
    if (method === "Target.detachedFromTarget" && sessionId === undefined && text("sessionId") === this.sessionId) {
      this.isGone = true;
    }
    const onPage = sessionId === this.sessionId;
    if (
      (method === "Target.targetCrashed" && text("targetId") === this.targetId) ||
      (method === "Inspector.targetCrashed" && onPage)
    ) {
      this.isCrashed = true;
    } else if (method === "Inspector.targetReloadedAfterCrash" && onPage) {
      this.isCrashed = false;
    }
    if (method === "Target.targetCreated") {
      const info = member(params, "targetInfo");
      if (member(info, "type") === "page" && member(info, "openerId") === this.targetId) {
        // Unsaid, it is taken to reach its opener.
        const reachesOpener = member(info, "canAccessOpener") !== false;
        const opened = String(member(info, "targetId"));
        this.opened.set(opened, { targetId: opened, reachesOpener });
      }
    }
    if (sessionId === undefined || (!onPage && !this.children.has(sessionId))) return;
    switch (method) {
      case "Network.requestWillBeSent": {
        const type = text("type");
        if (type === undefined || !OPEN_ENDED.includes(type)) {
          const id = `${sessionId}:${member(params, "requestId")}`;
          this.inflight.set(id, Date.now());
          if (!onPage) this.childRequests.add(id);
          if (type === DOCUMENT_TYPE) this.documentRequests.add(id);
          // Only a request to a web address is logged with what it is; any other counts as one that answers.
          if (
            WEB_PROTOCOLS.includes(URL.parse(string(member(member(params, "request"), "url")) ?? "")?.protocol ?? "")
          ) {
            // A redirect reuses the request id: the request is the same one, now at its new address.
            this.requests.delete(id);
            this.requests.set(id, {
              type,
              sessionId,
              loaderId: text("loaderId"),
              frameId: text("frameId"),
              ended: false,
            });
            this.trimRequests();
          }
        }
        this.lastNetwork = Date.now();
        if (onPage) this.lastPageNetwork = this.lastNetwork;
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const id = `${sessionId}:${member(params, "requestId")}`;
        this.inflight.delete(id);
        this.childRequests.delete(id);
        const request = this.requests.get(id);
        if (request) request.ended = true;
        this.trimRequests();
        this.lastNetwork = Date.now();
        if (onPage) this.lastPageNetwork = this.lastNetwork;
        break;
      }
      case "Page.frameNavigated": {
        const frame = member(params, "frame");
        if (!onPage || member(frame, "parentId")) break;
        // The frame's address comes without its fragment, which is apart.
        this.address = `${string(member(frame, "url")) ?? ""}${string(member(frame, "urlFragment")) ?? ""}`;
        // Navigation commits before its response finishes: only the previous document's requests are retired.
        const [frameId, loaderId] = [string(member(frame, "id")), string(member(frame, "loaderId"))];
        this.forget((request) => request.frameId === frameId && request.loaderId !== loaderId);
        break;
      }
      case "Page.navigatedWithinDocument":
        // The page's own frame has its target's id.
        if (onPage && text("frameId") === this.targetId) this.address = text("url") ?? "";
        break;
      case "Page.frameDetached": {
        // On a process swap, the old session's requests stop receiving completion events here.
        const frameId = text("frameId");
        this.forget((request) => request.frameId === frameId);
        break;
      }
      case "Page.javascriptDialogOpening":
        // A dialog stops the page until answered: an alert or a leave-page prompt is accepted; a confirm or a
        // prompt is declined (nothing is agreed to on the person's behalf).
        this.send(
          "Page.handleJavaScriptDialog",
          { accept: ACCEPTED_DIALOGS.includes(text("type") ?? "") },
          sessionId,
        ).catch(() => {});
        break;
      case "Target.attachedToTarget": {
        const child = text("sessionId");
        if (!child) break;
        const info = member(params, "targetInfo");
        if (member(info, "type") === "iframe") {
          this.children.set(child, {
            sessionId: child,
            targetId: String(member(info, "targetId")),
            parentSessionId: sessionId,
          });
          this.prepare(child, false).catch(() => {});
        } else {
          this.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
        }
        break;
      }
      case "Target.detachedFromTarget": {
        const child = text("sessionId");
        if (!child) break;
        this.children.delete(child);
        this.forget((request) => request.sessionId === child);
        break;
      }
    }
  }

  /** Forgets the requests that match: they will hear no end here. */
  private forget(matches: (request: LoggedRequest) => boolean): void {
    for (const [id, request] of this.requests) {
      if (!matches(request)) continue;
      this.requests.delete(id);
      this.inflight.delete(id);
      this.childRequests.delete(id);
    }
  }

  /** Bounds the request log, the ended ones going first. */
  private trimRequests(): void {
    for (const [id, request] of this.requests) {
      if (this.requests.size <= REQUEST_LOG_SIZE) break;
      if (request.ended) this.requests.delete(id);
    }
  }

  /** Whether a page or frame document is still loading; requests no longer open are forgotten here. */
  private documentLoading(): boolean {
    for (const id of this.documentRequests) if (!this.inflight.has(id)) this.documentRequests.delete(id);
    return this.documentRequests.size > 0;
  }

  /** Whether a document is loading in the page's own frame (whose id is its target's): a navigation under way. */
  private pageDocumentLoading(): boolean {
    if (!this.documentLoading()) return false;
    return [...this.documentRequests].some((id) => this.requests.get(id)?.frameId === this.targetId);
  }

  /** Whether a request is one of data or code the page's own frame asked for (`OPEN_DATA_TYPES`). */
  private pageData(id: string): boolean {
    const request = this.requests.get(id);
    return request?.frameId === this.targetId && OPEN_DATA_TYPES.includes(request.type ?? OTHER_TYPE);
  }

  /** The page's state for a settle, asked by `until` (epoch ms); undefined when unreadable. */
  private async settleRead(until: number): Promise<{ ready: string; quiet: number; steady: number } | undefined> {
    const read = { expression: SETTLE_READ, returnByValue: true };
    const answer = await this.send("Runtime.evaluate", read, undefined, { until }).catch(() => undefined);
    const value = member(member(answer, "result"), "value");
    if (!value) return undefined;
    return {
      ready: string(member(value, "ready")) ?? "",
      quiet: number(member(value, "quiet")) ?? Number.NaN,
      steady: number(member(value, "steady")) ?? Number.NaN,
    };
  }

  private async objectOf(backendNodeId: number, sessionId: string): Promise<unknown> {
    const answer = await this.send("DOM.resolveNode", { backendNodeId }, sessionId).catch(() => undefined);
    const object = member(answer, "object");
    if (!object) throw new InputRefused("gone");
    return member(object, "objectId");
  }

  private async offsetOf(sessionId: string): Promise<Point> {
    const frame = this.frames().find((candidate) => (candidate.sessionId ?? this.sessionId) === sessionId);
    return frame ? this.frameOffset(frame) : { x: 0, y: 0 };
  }

  /**
   * No box means one of two things: the element is still in the document but not drawn, or the page replaced it since
   * it was read. Which one decides what the model is told.
   */
  private async noBox(backendNodeId: number, sessionId: string): Promise<InputRefused> {
    const connected = await this.on(backendNodeId, sessionId, IS_CONNECTED).catch(() => undefined);
    return new InputRefused(connected ? "hidden" : "gone");
  }

  /**
   * A point inside the element that the element itself receives (not something drawn over it), in the page's
   * viewport. The probe points are tried in turn.
   */
  private async pointOn(backendNodeId: number, sessionId: string): Promise<Point> {
    const answer = await this.send("DOM.getContentQuads", { backendNodeId }, sessionId).catch(() => undefined);
    const quad = answer ? drawnQuad(items(member(answer, "quads"))) : undefined;
    if (!quad) throw await this.noBox(backendNodeId, sessionId);
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const points = CLICK_PROBE_FRACTIONS.map(([fx, fy]) => ({
      x: left + (right - left) * fx,
      y: top + (bottom - top) * fy,
    }));
    // The points are in the viewport of the session's root frame, as input events take them. The element's own
    // document has another origin when it sits in an iframe that shares the page's process: its border box, known
    // in both, gives the shift between the two.
    const model = await this.send("DOM.getBoxModel", { backendNodeId }, sessionId).catch(() => undefined);
    const border = items(member(member(model, "model"), "border")).map((side) => number(side) ?? Number.NaN);
    const corner = model
      ? {
          x: Math.min(border[0]!, border[2]!, border[4]!, border[6]!),
          y: Math.min(border[1]!, border[3]!, border[5]!, border[7]!),
        }
      : null;
    const hits = items(await this.on(backendNodeId, sessionId, HITS_AT, [points, corner]));
    const index = hits.findIndex((hit) => member(hit, "ok"));
    if (index < 0) {
      const by = hits.map((hit) => string(member(hit, "by"))).find((said) => said);
      throw new InputRefused("covered", by ?? "");
    }
    const offset = await this.offsetOf(sessionId);
    return { x: points[index]!.x + offset.x, y: points[index]!.y + offset.y };
  }

  /** The visible label that stands in for a hidden checkbox or radio. */
  private async labelPoint(backendNodeId: number, sessionId: string): Promise<Point | undefined> {
    try {
      const objectId = await this.objectOf(backendNodeId, sessionId);
      const answer = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: LABEL_OF }, sessionId);
      const label = member(member(answer, "result"), "objectId");
      if (!label) return undefined;
      // Where the browser draws it, in the coordinates input events take.
      const quads = await this.send("DOM.getContentQuads", { objectId: label }, sessionId);
      const quad = drawnQuad(items(member(quads, "quads")));
      if (!quad) return undefined;
      const offset = await this.offsetOf(sessionId);
      return { x: (quad[0]! + quad[4]!) / 2 + offset.x, y: (quad[1]! + quad[5]!) / 2 + offset.y };
    } catch {
      return undefined;
    }
  }

  /** Scrolls the element into view: the browser's own scroll, else the element's `scrollIntoView`. */
  private async scrollIntoView(backendNodeId: number, sessionId: string): Promise<void> {
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
    } catch {
      await this.on(backendNodeId, sessionId, SCROLL_TO_CENTRE);
    }
  }

  private async reachablePoint(backendNodeId: number, sessionId: string): Promise<Point> {
    try {
      return await this.pointOn(backendNodeId, sessionId);
    } catch (error) {
      if (!(error instanceof InputRefused) || error.reason !== "covered") throw error;
      // Sticky headers and cookie bars cover what sits at the viewport's edge: centre it and look again.
      await this.on(backendNodeId, sessionId, SCROLL_TO_CENTRE);
      await this.connection.wait(RECENTRE_WAIT_MS);
      return this.pointOn(backendNodeId, sessionId);
    }
  }

  /** Focuses the element: the browser's own focus, else the element's. */
  async focus(backendNodeId: number, sessionId: string): Promise<void> {
    try {
      await this.send("DOM.focus", { backendNodeId }, sessionId);
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
      await this.on(backendNodeId, sessionId, FOCUS);
    }
  }

  /** One character as a key press: keydown carrying the text, then keyup. */
  private async typeCharacter(character: string): Promise<void> {
    const letter = /^[a-z]$/i.test(character);
    const digit = /^[0-9]$/.test(character);
    const keyCode = letter || digit ? character.toUpperCase().charCodeAt(0) : 0;
    const common = {
      key: character,
      ...(digit ? { code: `Digit${character}` } : letter ? { code: `Key${character.toUpperCase()}` } : {}),
      ...(keyCode ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}),
    };
    await this.send("Input.dispatchKeyEvent", {
      ...common,
      type: "keyDown",
      text: character,
      unmodifiedText: character,
    });
    await this.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  }

  /** Ctrl+A as the keyboard sends it, with the `selectAll` editing command. */
  private async selectAll(): Promise<void> {
    const common = {
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: SELECT_ALL_MODIFIER,
    };
    await this.send("Input.dispatchKeyEvent", { ...common, type: "rawKeyDown", commands: ["selectAll"] });
    await this.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  }
}
