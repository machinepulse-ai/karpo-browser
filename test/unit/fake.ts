/**
 * A browser the unit tests make up: pages written as trees of nodes and given as Chrome gives a page (a DOM snapshot
 * and an accessibility tree), a tab that shows one of a site's pages at a time and moves between them as the site
 * says, and a decision model that answers by rule and keeps every request. A run on it takes no time when the clock is
 * held still: its requests come out the same, character for character, every time.
 */

import { createHash } from "node:crypto";
import type { Connection } from "../../src/browser/cdp.ts";
import type { Pages } from "../../src/browser/pages.ts";
import type { BrowserSolve, SettleRules, Shot, Tab } from "../../src/browser/tab.ts";
import { Timings } from "../../src/browser/timings.ts";
import type { PageCapture, RawSnapshot } from "../../src/contracts/capture.ts";
import { SNAPSHOT_STYLES } from "../../src/contracts/capture.ts";
import type { Decider, DecisionRequest } from "../../src/decider/systemone.ts";

/** The viewport, and the row each node is laid out on, one below the other. */
const VIEWPORT = { w: 1280, h: 720 };
const ROW_PX = 20;
const NODE_HEIGHT_PX = 16;
const NODE_WIDTH_PX = 600;
/** The page's session, target and frame. */
const SESSION = "S";
const TARGET = "T";
const FRAME = "F";
/** The tags laid out inside a line, and those that take a click. */
const INLINE_TAGS = ["a", "span"];
const CLICKED_TAGS = ["a", "button"];
/** What the run asks the page by expression. */
const PAGE_URL = "location.href";
const READY_STATE = "document.readyState";
/** What `Page.navigate` says of an address no page of the site has. */
const NOT_RESOLVED = "net::ERR_NAME_NOT_RESOLVED";
/** The screenshot the tab gives: a few bytes, sized as a 768-pixel-wide viewport's. */
const SHOT: Shot = { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 768, height: 432 };

/** A node of a made-up page: a run of text, or an element. */
export type Made = string | MadeElement;

export interface MadeElement {
  tag: string;
  attrs?: Record<string, string>;
  /** Its node in the accessibility tree: role, name and properties; none where the tree leaves it out. */
  role?: string;
  name?: string;
  props?: Record<string, string>;
  children?: Made[];
}

/** A made-up page: its address, title and what its body holds. */
export interface MadePage {
  url: string;
  title: string;
  body: Made[];
  /** The backend node id of its first node, the others after it: a page drawn anew has nodes of its own. */
  firstId?: number;
}

export function main(...children: Made[]): MadeElement {
  return { tag: "main", role: "main", children };
}

export function heading(name: string): MadeElement {
  return { tag: "h1", role: "heading", name, children: [name] };
}

export function link(name: string, href: string): MadeElement {
  return { tag: "a", attrs: { href }, role: "link", name, children: [name] };
}

export function button(name: string): MadeElement {
  return { tag: "button", role: "button", name, children: [name] };
}

/** A box that takes a typed value. */
export function textbox(name: string): MadeElement {
  return { tag: "input", attrs: { type: "text", "aria-label": name }, role: "textbox", name };
}

/** A native dropdown with these options, by their texts. */
export function dropdown(name: string, options: readonly string[]): MadeElement {
  const children = options.map(
    (text): MadeElement => ({ tag: "option", role: "option", name: text, children: [text] }),
  );
  return { tag: "select", attrs: { "aria-label": name }, role: "combobox", name, children };
}

/** The slides of the deals page's carousel: one more turn at each reading. */
const SLIDES = [
  { title: "Save 20% on trail shoes", href: "/sale/trail" },
  { title: "Free shipping over $50", href: "/shipping" },
  { title: "New: waterproof boots", href: "/new/boots" },
];

/**
 * A page that changes by itself at each reading, as the page marks it: a carousel whose slide
 * turns, a timer that ticks, a status and a live region whose words change, a marquee; and the sizes a button shows
 * or hides.
 */
export function deals(reading: number, sizes: boolean): MadePage {
  const at = reading % SLIDES.length;
  const slide = SLIDES[at]!;
  const turned = `${at + 1} of ${SLIDES.length}`;
  const carousel: MadeElement = {
    tag: "section",
    attrs: { "aria-roledescription": "carousel", "aria-label": "Featured" },
    role: "region",
    name: "Featured",
    props: { roledescription: "carousel" },
    children: [
      {
        tag: "div",
        attrs: { "aria-roledescription": "slide", "aria-label": turned },
        role: "group",
        name: turned,
        props: { roledescription: "slide" },
        children: [heading(slide.title), link("Shop now", slide.href)],
      },
    ],
  };
  const live: MadeElement = {
    tag: "div",
    attrs: { "aria-live": "polite" },
    role: "generic",
    props: { live: "polite" },
    children: [`${3 + (reading % 2)} shoppers viewing`, link("See all", "/all")],
  };
  return {
    url: "https://shop.test/deals",
    title: "Deals",
    body: [
      main(
        heading("Today's deals"),
        carousel,
        { tag: "div", attrs: { role: "timer" }, role: "timer", children: [`Ends in 00:${59 - (reading % 60)}`] },
        {
          tag: "div",
          attrs: { role: "status" },
          role: "status",
          props: { live: "polite" },
          children: [`Saved ${reading}s ago`],
        },
        live,
        { tag: "marquee", role: "marquee", children: [`Free returns on ${reading % 2 === 0 ? "shoes" : "boots"}`] },
        button(sizes ? "Hide sizes" : "Show sizes"),
        ...(sizes ? ["Sizes 7 to 12"] : []),
      ),
    ],
  };
}

/** A page as Chrome gives it: its document's snapshot, its accessibility tree's nodes, its elements by backend id. */
export function snapshotOf(page: MadePage): {
  snapshot: RawSnapshot;
  accessibility: unknown[];
  elements: Map<number, MadeElement>;
} {
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const at = (text: string) => {
    let index = indexes.get(text);
    if (index === undefined) {
      index = strings.length;
      strings.push(text);
      indexes.set(text, index);
    }
    return index;
  };
  const nodes = {
    parentIndex: [] as number[],
    nodeType: [] as number[],
    nodeName: [] as number[],
    nodeValue: [] as number[],
    backendNodeId: [] as number[],
    attributes: [] as number[][],
    isClickable: { index: [] as number[] },
  };
  const layout = { nodeIndex: [] as number[], bounds: [] as number[][], styles: [] as number[][] };
  const accessibility: unknown[] = [];
  const elements = new Map<number, MadeElement>();
  const firstId = page.firstId ?? 1;
  const styleOf = (display: string, cursor: string) => {
    const values: Record<string, string> = {
      display,
      visibility: "visible",
      cursor,
      "overflow-x": "visible",
      "overflow-y": "visible",
      position: "static",
      "background-color": "rgba(0, 0, 0, 0)",
      opacity: "1",
      "pointer-events": "auto",
      "clip-path": "none",
    };
    return SNAPSHOT_STYLES.map((name) => at(values[name]!));
  };
  const add = (type: number, name: string, value: string, parent: number, attrs: Record<string, string>) => {
    const index = nodes.parentIndex.length;
    nodes.parentIndex.push(parent);
    nodes.nodeType.push(type);
    nodes.nodeName.push(at(name));
    nodes.nodeValue.push(at(value));
    nodes.backendNodeId.push(firstId + index);
    nodes.attributes.push(Object.entries(attrs).flatMap(([key, held]) => [at(key), at(held)]));
    return index;
  };
  const lay = (index: number, style: number[]) => {
    const row = layout.nodeIndex.length;
    layout.nodeIndex.push(index);
    layout.bounds.push([0, ROW_PX * row, NODE_WIDTH_PX, NODE_HEIGHT_PX]);
    layout.styles.push(style);
  };
  const walk = (made: Made, parent: number, style: number[]) => {
    if (typeof made === "string") {
      lay(add(3, "#text", made, parent, {}), style);
      return;
    }
    const index = add(1, made.tag.toUpperCase(), "", parent, made.attrs ?? {});
    const id = firstId + index;
    elements.set(id, made);
    const clicked = CLICKED_TAGS.includes(made.tag);
    const own = styleOf(INLINE_TAGS.includes(made.tag) ? "inline" : "block", clicked ? "pointer" : "auto");
    if (clicked) nodes.isClickable.index.push(index);
    lay(index, own);
    if (made.role !== undefined) {
      accessibility.push({
        nodeId: String(id),
        backendDOMNodeId: id,
        ignored: false,
        role: { type: "role", value: made.role },
        name: { type: "computedString", value: made.name ?? "" },
        properties: Object.entries(made.props ?? {}).map(([name, value]) => ({
          name,
          value: { type: "token", value },
        })),
      });
    }
    for (const child of made.children ?? []) walk(child, index, own);
  };
  const document = add(9, "#document", "", -1, {});
  walk({ tag: "html", children: [{ tag: "body", children: page.body }] }, document, styleOf("block", "auto"));
  return {
    snapshot: { documents: [{ documentURL: at(page.url), title: at(page.title), nodes, layout }], strings },
    accessibility,
    elements,
  };
}

/** A page as one capture of a tab gives it. */
export function captureOf(page: MadePage): PageCapture {
  const { snapshot, accessibility } = snapshotOf(page);
  const frame = { session: SESSION, target: TARGET, top: true, offset: { x: 0, y: 0 }, snapshot };
  return {
    viewport: { ...VIEWPORT },
    scroll: { top: 0, maxTop: 0 },
    frames: [{ ...frame, accessibility: [accessibility] }],
    unreadFrames: 0,
    styles: [...SNAPSHOT_STYLES],
  };
}

/**
 * A site made up for a test: its pages by a name of the test's, each as it reads at a reading of the tab (counted
 * from 0: what changes on a page by itself changes with it); the page a run starts on; and where a click on an
 * element leads, by the name of a page (the page shown, for a click that changes nothing). A click the site says
 * nothing of leads a link to the page at its address, and leaves any other element as it was.
 */
export interface Site {
  pages: Record<string, (reading: number) => MadePage>;
  start: string;
  click?(on: string, element: MadeElement): string | undefined;
}

/** A tab showing a site: the pages it went to, in order, and the one it shows. */
export class FakeTab {
  readonly sessionId = SESSION;
  readonly targetId = TARGET;
  readonly gone = false;
  readonly crashed = false;
  /** The addresses opened with `Page.navigate`, in order. */
  readonly navigated: string[] = [];
  /** Whether a tab was opened from it: none is, unless a test says so. */
  opens = false;
  /** What `Page.navigate` answers first, one a navigation, before it opens anything: the browser's errors. */
  readonly refusals: string[] = [];
  /**
   * The settles asked of the tab, in order: which settle, its longest time and what it followed; an action's settle
   * and a wait for a change (no longest time) too.
   */
  readonly settles: [string, number | undefined, string | undefined][] = [];
  /** The rules each of those settles was given, in the same order: undefined for the tab's own. */
  readonly rules: (SettleRules | undefined)[] = [];
  /** The commands sent to the tab, in order. */
  readonly sent: string[] = [];
  /** How many screenshots were taken, and how long one takes to come (ms). */
  shots = 0;
  shotMs = 0;
  /** How many screenshots are being taken now, and what was done on the tab while one was: an action, or another. */
  capturing = 0;
  readonly duringShot: string[] = [];
  /** What was typed into boxes, and the options set on dropdowns (by live index and text), by backend node id. */
  readonly filled = new Map<number, string>();
  readonly selected: [number, number, string][] = [];
  /** How the browser's own solving of a verification ends when it is waited for (none goes on, unless a test says so). */
  browserSolving: BrowserSolve = "none";
  /** How often it was waited for. */
  browserSolves = 0;
  private readonly site: Site;
  private readonly entries: string[];
  private current = 0;
  private readings = 0;

  constructor(site: Site) {
    this.site = site;
    this.entries = [site.start];
  }

  /** The tab as the run drives it. */
  get tab(): Tab {
    return this as unknown as Tab;
  }

  get url(): string {
    return this.page(this.showing).url;
  }

  /** The name of the page the tab shows. */
  get showing(): string {
    return this.entries[this.current]!;
  }

  frames(): { sessionId: string | undefined; targetId: string; parentSessionId: string | undefined }[] {
    return [{ sessionId: undefined, targetId: TARGET, parentSessionId: undefined }];
  }

  takeOpened(): [] {
    return [];
  }

  hasOpened(): boolean {
    return this.opens;
  }

  async evaluate(expression: string): Promise<unknown> {
    if (expression === PAGE_URL) return this.url;
    if (expression === READY_STATE) return "complete";
    throw new Error(`the made-up tab does not evaluate ${expression}`);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push(method);
    if (method === "Page.navigate" || method === "Page.navigateToHistoryEntry") this.doneDuringShot(method);
    switch (method) {
      case "Page.getLayoutMetrics":
        return {
          cssVisualViewport: { clientWidth: VIEWPORT.w, clientHeight: VIEWPORT.h, pageX: 0, pageY: 0 },
          cssContentSize: { width: VIEWPORT.w, height: VIEWPORT.h },
        };
      case "DOMSnapshot.captureSnapshot":
        this.readings += 1;
        return this.shown().snapshot;
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: FRAME } } };
      case "Accessibility.getFullAXTree":
        return { nodes: this.shown().accessibility };
      case "Accessibility.getPartialAXTree": {
        const id = params.backendNodeId;
        const node = this.shown().accessibility.find(
          (ax) => (ax as { backendDOMNodeId: unknown }).backendDOMNodeId === id,
        );
        return { nodes: [node ?? { backendDOMNodeId: id, role: { value: "" }, name: { value: "" } }] };
      }
      case "Page.getNavigationHistory":
        return { currentIndex: this.current, entries: this.entries.map((_, id) => ({ id })) };
      case "Page.navigateToHistoryEntry":
        this.current = Number(params.entryId);
        return {};
      case "Page.navigate": {
        const url = String(params.url);
        this.navigated.push(url);
        const name = this.named(url);
        const refused = this.refusals.shift();
        if (refused !== undefined || name === undefined) return { frameId: FRAME, errorText: refused ?? NOT_RESOLVED };
        this.go(name);
        return { frameId: FRAME };
      }
      default:
        throw new Error(`the made-up tab does not answer ${method}`);
    }
  }

  /** A click on the element of a backend node id: where the site says it leads; a link, to its address. */
  async click(backendNodeId: number): Promise<void> {
    this.doneDuringShot("click");
    const element = this.shown().elements.get(backendNodeId);
    if (!element) throw new Error(`no element ${backendNodeId} on ${this.showing}`);
    const href = element.attrs?.href;
    const next =
      this.site.click?.(this.showing, element) ??
      (href === undefined ? undefined : this.named(new URL(href, this.url).href));
    if (next !== undefined) this.go(next);
  }

  /** What a function run on an element gives: its `href` attribute, the one thing the run asks of an element here. */
  async on(backendNodeId: number): Promise<unknown> {
    return this.shown().elements.get(backendNodeId)?.attrs?.href ?? null;
  }

  /** A value typed into a box: kept, and read back as it was typed. */
  async fill(backendNodeId: number, _session: string, text: string): Promise<string> {
    this.filled.set(backendNodeId, text);
    return text;
  }

  async valueOf(backendNodeId: number): Promise<string | undefined> {
    return this.filled.get(backendNodeId);
  }

  async selectIndex(backendNodeId: number, _session: string, index: number, text: string): Promise<void> {
    this.selected.push([backendNodeId, index, text]);
  }

  async browserSolve(): Promise<BrowserSolve> {
    this.browserSolves += 1;
    return this.browserSolving;
  }

  async settle(maxMs?: number, kind?: string, rules?: SettleRules): Promise<string> {
    this.settles.push(["settle", maxMs, kind]);
    this.rules.push(rules);
    return "quiet";
  }

  async settleOpened(maxMs?: number, kind?: string): Promise<string> {
    this.settles.push(["settleOpened", maxMs, kind]);
    this.rules.push(undefined);
    return "document_complete";
  }

  async settleAfter(_since: number, maxMs: number, rules?: SettleRules): Promise<string> {
    this.settles.push(["settleAfter", maxMs, "action"]);
    this.rules.push(rules);
    return "quiet";
  }

  /** Captures are not timed here. */
  noteCapture(): void {}

  async changed(_since: number, _until: number, rules?: SettleRules): Promise<string> {
    this.settles.push(["changed", undefined, "wait"]);
    this.rules.push(rules);
    return "unchanged";
  }

  /** The viewport's screenshot, `shotMs` after it is asked. */
  async viewportJpeg(_quality?: number, _width?: number): Promise<Shot> {
    this.shots += 1;
    this.doneDuringShot("screenshot");
    this.capturing += 1;
    if (this.shotMs > 0) await new Promise((resolve) => setTimeout(resolve, this.shotMs));
    this.capturing -= 1;
    return SHOT;
  }

  /** Notes `what` was done on the tab, if a screenshot was being taken then. */
  private doneDuringShot(what: string): void {
    if (this.capturing > 0) this.duringShot.push(what);
  }

  private page(name: string): MadePage {
    const page = this.site.pages[name];
    if (!page) throw new Error(`the site has no page ${name}`);
    return page(this.readings);
  }

  private shown(): ReturnType<typeof snapshotOf> {
    return snapshotOf(this.page(this.showing));
  }

  /** The name of the site's page at an address, its fragment aside. */
  private named(url: string): string | undefined {
    const wanted = url.split("#", 1)[0];
    return Object.keys(this.site.pages).find((name) => this.page(name).url === wanted);
  }

  /** The tab goes to a page: one at another address is a new entry of its history; one at the same, the page changed. */
  private go(name: string): void {
    if (this.page(name).url === this.url) {
      this.entries[this.current] = name;
      return;
    }
    this.entries.length = this.current + 1;
    this.entries.push(name);
    this.current += 1;
  }
}

type Listener = (method: string, params: unknown, sessionId: string | undefined) => void;

/**
 * A connection to a made-up browser, for a real tab (`Tab.attach` on it): every command is answered, a settle's read
 * of the page as `page` says it at the time; the events a test tells go to the tab, of its page's own session; its
 * waits are timers, and it keeps the browser's timings.
 */
export class FakeConnection {
  readonly timings = new Timings();
  /** The page's ready state, and when its document last changed (epoch ms). */
  page = { ready: "complete", changedAt: Date.now() };
  private readonly listeners = new Set<Listener>();

  /** The connection as a tab takes it. */
  get connection(): Connection {
    return this as unknown as Connection;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "Target.attachToTarget") return { sessionId: SESSION };
    if (method === "Runtime.evaluate" && String(params.expression).includes(READY_STATE)) {
      const quiet = Date.now() - this.page.changedAt;
      return { result: { value: { ready: this.page.ready, quiet, steady: quiet } } };
    }
    return {};
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Tells the tab an event of its page's own session. */
  tell(method: string, params: object): void {
    for (const listener of this.listeners) listener(method, params, SESSION);
  }
}

/** What the tabs a made-up browser makes are called: their targets and their sessions, numbered from 1. */
const MADE_TARGET = "made-";
const MADE_SESSION = "session-";
/** How long since a made-up page's document last changed, as a settle reads it: long enough to be quiet. */
const STILL_MS = 60_000;
/** A JPEG's start and its frame header, of a 1280 × 720 picture: what a made-up browser pictures a page as. */
export const MADE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * A connection to a made-up browser that makes tabs of its own (`Target.createTarget`), each worked by a real tab
 * (`Tab.attach` on it): a tab shows the site's page at the address `Page.navigate` opens in it (an address no page has
 * fails as a name not found), read and pictured as Chrome gives a page, its document long still; any other
 * expression evaluated there answers true. It keeps every command with its session, and the targets not closed yet.
 */
export class FakeBrowserConnection {
  readonly timings = new Timings();
  /** Every command, in order: its method, its parameters and its session (none for the browser's own). */
  readonly sent: { method: string; params: Record<string, unknown>; sessionId: string | undefined }[] = [];
  /** The targets made and not closed yet. */
  readonly targets = new Set<string>();
  private readonly pages: readonly MadePage[];
  /** The page each tab shows, by its session. */
  private readonly showing = new Map<string, MadePage>();
  private made = 0;

  constructor(pages: readonly MadePage[]) {
    this.pages = pages;
  }

  /** The connection as a browser and its tabs take it. */
  get connection(): Connection {
    return this as unknown as Connection;
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, sessionId });
    switch (method) {
      case "Target.createTarget": {
        this.made += 1;
        const targetId = `${MADE_TARGET}${this.made}`;
        this.targets.add(targetId);
        return { targetId };
      }
      case "Target.closeTarget":
        return { success: this.targets.delete(String(params.targetId)) };
      case "Target.attachToTarget":
        return { sessionId: `${MADE_SESSION}${String(params.targetId)}` };
      case "Page.navigate": {
        const page = this.pages.find((each) => each.url === params.url);
        if (!page) return { frameId: FRAME, errorText: NOT_RESOLVED };
        this.showing.set(sessionId ?? "", page);
        return { frameId: FRAME };
      }
      case "Runtime.evaluate":
        if (String(params.expression).includes(READY_STATE)) {
          return { result: { value: { ready: "complete", quiet: STILL_MS, steady: STILL_MS } } };
        }
        return { result: { value: true } };
      case "Page.getLayoutMetrics":
        return {
          cssVisualViewport: { clientWidth: VIEWPORT.w, clientHeight: VIEWPORT.h, pageX: 0, pageY: 0 },
          visualViewport: { clientWidth: VIEWPORT.w },
          cssContentSize: { width: VIEWPORT.w, height: VIEWPORT.h },
        };
      case "DOMSnapshot.captureSnapshot":
        return snapshotOf(this.shownOn(sessionId)).snapshot;
      case "Accessibility.getFullAXTree":
        return { nodes: snapshotOf(this.shownOn(sessionId)).accessibility };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: FRAME } } };
      case "Page.captureScreenshot":
        return { data: Buffer.from(MADE_JPEG).toString("base64") };
      default:
        return {};
    }
  }

  /** It tells no events. */
  on(): () => void {
    return () => {};
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shownOn(sessionId: string | undefined): MadePage {
    const page = this.showing.get(sessionId ?? "");
    if (!page) throw new Error(`no page is open on ${sessionId}`);
    return page;
  }
}

/** The run's pages on one made-up tab: no tab opens, no secret is typed. */
export function pagesOf(tab: FakeTab): Pages {
  const pages = {
    current: () => tab.tab,
    adoptOpened: async () => {},
    typedTexts: () => [],
    typedSecrets: () => new Set<string>(),
    secretTyped: false,
    canGoBackToOpener: () => false,
    backToOpener: async () => {},
    markSecret: () => {},
    unmarkSecret: () => {},
  };
  return pages as unknown as Pages;
}

/** What a rule reads of a step's request: the page's lines, and the number of the element a line names. */
export interface Asked {
  lines: readonly string[];
  has(words: string): boolean;
  numberOf(words: string): string;
}

/**
 * A decision model that answers each step by rule, sure of it and of the run going on, and keeps every request. A
 * follow-up it is asked (`value` or `option` alone, `value 7` in a step's request) it answers as `followups` says by
 * the question's name, sure of it too; one they do not name, it does not answer.
 */
export function scripted(
  step: (asked: Asked) => string,
  followups: Readonly<Record<string, string>> = {},
): Decider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    async ask(request) {
      requests.push(request);
      const lines = request.state.page.elements;
      const choice = step({
        lines,
        has: (words) => lines.some((line) => line.includes(words)),
        numberOf: (words) => /^\s*(\d+) /.exec(lines.find((line) => line.includes(words)) ?? "")?.[1] ?? "?",
      });
      const followed = Object.keys(request.questions).flatMap((name) => {
        const chosen = followups[name];
        return chosen === undefined ? [] : [[name, { choice: chosen, probabilities: { [chosen]: 0.9 } }] as const];
      });
      return {
        answers: {
          step: { choice, probabilities: { [choice]: 0.9 } },
          looping: { noul: 0.01 },
          ...Object.fromEntries(followed),
        },
      };
    },
  };
}

/** What a test compares of a request: the state the model reads, and a hash of the whole request, byte for byte. */
export function fingerprint(request: DecisionRequest): { sha256: string; state: object } {
  return { sha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), state: request.state };
}
