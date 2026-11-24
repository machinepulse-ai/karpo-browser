/**
 * The page as the decision model reads it: the accessibility tree, laid out by the DOM snapshot taken in the same
 * capture, pared down, numbered, and cut into what the viewport shows and what lies above and below it.
 *
 * - Numbered in the viewport: every drawn element with words of its own on the screen, a role of its own or a click
 *   signal (the snapshot's `isClickable`, a hand cursor of its own, a tab stop), but a wrapper with none of these,
 *   whose elements take its place. Scroll areas in the viewport too.
 * - Numbered off the screen: the controls a person operates (by their accessibility role), and elements with no such
 *   role a click signal marks.
 * - Covered: what the opaque boxes drawn after it cover whole is not read (a dialog's mask hides the form behind it).
 * - Not numbered: regions, headings and text; the controls a heading holds follow it.
 * - Numbers run in page order from 2 (1 is the page, the scroll target); they hold for one step: each binds the node
 *   it was read from (its frame's session and backend node id).
 */

import { PAGE_NUMBER } from "../contracts/actions.ts";
import type { PageCapture, Scroll } from "../contracts/capture.ts";
import { yes } from "../json.ts";
import { asciiLower, collapse, cut, integer, length, sameButAsciiCase, trim, words } from "../text.ts";
import type { DomNode, ScrollBox } from "./dom.ts";
import { capturedDom, isElement, isText, readGeneratedContent } from "./dom.ts";
import type { Rect } from "./geometry.ts";
import { BoxUnion, NO_RECT, overlap } from "./geometry.ts";

/** Roles a person operates: numbered wherever they are. */
const CONTROL_ROLES = [
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "Date",
  "DateTime",
  "InputTime",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "DisclosureTriangle",
  "PopUpButton",
  "ToggleButton",
  "MenuListOption",
];
/** Roles that take a value: typed, or set as the browser's own control sets it (a date, a time, a slider). */
const INPUT_ROLES = ["textbox", "searchbox", "combobox", "spinbutton", "Date", "DateTime", "InputTime", "slider"];
/** Region roles written as a line of their own, the elements inside under them. */
const REGION_ROLES = [
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "dialog",
  "alertdialog",
  "menu",
  "menubar",
  "tablist",
  "toolbar",
  "radiogroup",
  "listbox",
  "grid",
  "table",
  "treegrid",
  "tree",
  "tabpanel",
  "feed",
];
/** Region roles written only when they have a name. */
const NAMED_REGION_ROLES = ["region", "group", "list", "article", "figure", "section"];
/** Image roles: one without a name is listed only when it takes a click. */
const IMAGE_ROLES = ["image", "img"];
/** A label's tag: a click on what it holds is a click on the control it names. */
const LABEL_TAG = "label";
/** Tags of the controls a label names. */
const LABELLED_TAGS = ["input", "select", "textarea", "button"];
/** The roles a structure node may have, which give way to the role of what it is (its tag). */
const GENERIC_ROLES = ["generic", "none", "presentation"];
/** Tags whose content is never shown. */
const SKIPPED_TAGS = ["script", "style", "noscript", "template", "head", "title", "meta", "link", "base", "svg"];
const HEADING_ROLE = "heading";
/** The role of a list item's bullet or number, which the browser draws. */
const LIST_MARKER_ROLE = "ListMarker";
const LIST_ITEM_ROLE = "listitem";
/** A frame's document element, whose content the iframe shows. */
const IFRAME_TAG = "iframe";
/** The attributes a node's markup names it by, in order, where the accessibility tree gives it no name. */
const MARKUP_NAME_ATTRS = ["aria-label", "alt", "title"];
/** The attribute that makes a node and all it holds inert: no click, focus or key reaches them. */
const INERT_ATTR = "inert";
/** An open popover is drawn in the top layer, over the page. */
const POPOVER_ATTR = "popover";
const CANVAS_TAG = "canvas";
const SELECT_TAG = "select";
const OPTION_TAG = "option";
const IMAGE_ROLE = "img";
/** The role a native dropdown is written with. */
const SELECT_ROLE = "select";
/** The tags of the document's own scroller, which the page's number scrolls. */
const PAGE_SCROLLER_TAGS = ["html", "body"];
/** A share of the viewport from which a clickable box is a layer over the page: the page around what it holds. */
const OVERLAY_SHARE = 0.5;
/** How much more a box's content must be than the box for it to scroll. */
const SCROLL_SLACK_PX = 2;
/** How far a clip reaches on an axis its box does not cut. */
const UNCUT_PX = 1.0e9;
/** The longest name an element's line writes; a longer one is cut. */
const NAME_MAX_CHARS = 200;
/** The longest text line: a whole paragraph is one line; a node longer than this is no paragraph read at once. */
export const TEXT_MAX_CHARS = 2_000;
/** The accessibility states the tree writes, in this order. */
const STATE_PROPS = ["expanded", "selected", "checked", "disabled", "required"];
/** A box whose text the platform hides draws it as dots. */
const PASSWORD_TYPE = "password";
/**
 * The opacity, its own and those of the boxes around it multiplied in, from which a box with a background hides what
 * is drawn under it.
 */
const OPAQUE_FROM = 0.8;
/** The display of a run of text inside a line. */
const INLINE_DISPLAY = "inline";
/** A letter or a digit: what a text says, whatever its spaces, punctuation and icon glyphs. */
const LETTER_OR_DIGIT = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u;
/** A reference with an empty host: two slashes, then another slash where the host would start. */
const HOSTLESS_REFERENCE = /^\/\/[/\\]/;
/** The last of the characters (controls and the space) a URL parser drops from the start of a reference. */
const LAST_DROPPED_CODE = 0x20;
/** The caret, the private-use character that stands in for it while an address is parsed, and that character escaped. */
const CARET = "^";
const CARET_STAND_IN = "\ue000";
const CARET_ESCAPED = "%EE%80%80";
/** The link schemes written as a path or a host and path. */
const WEB_PROTOCOLS = ["http:", "https:"];
/**
 * What a page marks as changing by itself (`changingOf`): a carousel or a slide of one (its role description, as the
 * accessibility tree or the markup gives it) and a marquee (its tag or role), whole; the words of a live region (polite
 * or assertive, as the tree gives it for every node in one, or the markup), of a status and of a timer.
 */
const ROLE_DESCRIPTION_PROP = "roledescription";
const ROLE_DESCRIPTION_ATTR = "aria-roledescription";
const CAROUSEL_DESCRIPTIONS = ["carousel", "slide"];
const MARQUEE = "marquee";
const LIVE_PROP = "live";
const LIVE_ATTR = "aria-live";
const LIVE_VALUES = ["polite", "assertive"];
const CHANGING_WORDS_ROLES = ["status", "timer"];

/** Where a line lies against the viewport. */
export type Part = "viewport" | "above" | "below";
export const PARTS: readonly Part[] = ["viewport", "above", "below"];

/**
 * How much an element is worth keeping when the viewport's elements do not all fit: what takes a value, then what
 * takes a click, then what was numbered only to fill the viewport up.
 */
export const Keep = { Filled: 0, Clickable: 1, Fillable: 2 } as const;
export type Keep = (typeof Keep)[keyof typeof Keep];

/** A node as the actions find it: its frame's CDP session and target, and its backend node id. */
export interface Binding {
  session: string;
  target: string;
  backendNodeId: number;
}

/** A box the platform typed a secret into, by its target and node: what outlives a CDP session. */
export function secretKey(target: string, backendNodeId: number): string {
  return `${backendNodeId} ${target}`;
}

/** One option of a native dropdown, by its live index. */
export interface SelectOption {
  index: number;
  text: string;
  value: string;
  selected: boolean;
  disabled: boolean;
}

/** What an element offers, by its kind. */
export type ElementKind =
  /** A box that takes a typed value (FILL, CLICK, PRESS_ENTER; no FILL when read-only). */
  | { kind: "input"; readonly: boolean }
  /** A native dropdown (SELECT): its options. */
  | { kind: "select"; options: SelectOption[] }
  /** Anything else one clicks. */
  | { kind: "click" }
  /** A scroll area: which ways it can scroll. */
  | { kind: "scroll"; down: boolean; up: boolean }
  /** Shown, not acted on: an option listed under its dropdown. */
  | { kind: "shown" };

/** A state an element's line writes: the state, and its value when it has one. */
export type ElementState = [name: string, value: string | undefined];

/** One numbered element. */
export interface Element {
  number: number;
  binding: Binding;
  /** The role as the line writes it ("button", "select", "div"). */
  role: string;
  /** The accessibility role and name as the browser gave them, checked again before acting. */
  axRole: string;
  axName: string;
  /** Its accessible name, whole (or, for an element with no name of its own that only holds text, its text). */
  name: string;
  states: ElementState[];
  /** Its value as typed (none for a secret box). */
  value: string | undefined;
  /** For a secret box: how many characters it holds. */
  secretLength: number | undefined;
  href: string | undefined;
  /** No role says it takes a click; a signal does. */
  clickable: boolean;
  /** It is in the viewport, has no control role and shows a hand cursor its parent does not. */
  pointer: boolean;
  /** Its name is the words it holds, it having none of its own: written as long as a line of text is. */
  words: boolean;
  disabled: boolean;
  kind: ElementKind;
  keep: Keep;
  part: Part;
  rect: Rect;
}

/** Whether an element is offered any step. */
export function acts(element: Element): boolean {
  return !element.disabled && element.kind.kind !== "shown";
}

/** What a line of the tree is. */
export type Line =
  /** A region: its role and name; the lines under it are deeper. */
  | { kind: "region"; role: string; name: string }
  | { kind: "heading"; name: string }
  | { kind: "text"; text: string }
  /** A numbered element, by its index in the tree's elements. */
  | { kind: "element"; element: number }
  /** An area the reading cannot read: what it is and, for a frame, its host. */
  | { kind: "unreadable"; what: string };

/** One line of the tree, in page order. */
export interface TreeLine {
  line: Line;
  depth: number;
  part: Part;
  /** The region line it is under, by index; none at the top. */
  parent: number | undefined;
}

/** The page as the decision model reads it. */
export interface PageTree {
  url: string;
  title: string;
  scroll: Scroll;
  viewport: Rect;
  elements: Element[];
  lines: TreeLine[];
  /**
   * The lines (by index) of what changes on the page by itself, as the page marks it (`changingOf`): a carousel, a
   * marquee, the words of a live region, a status or a timer. The decision model reads them as any other; the run's
   * check for going in circles leaves them out.
   */
  changing: Set<number>;
}

/** The element of a number. */
export function elementOf(tree: PageTree, number: number): Element | undefined {
  return tree.elements.find((element) => element.number === number);
}

/** Whether the page itself can scroll down, and up. */
export function pageScrolls(tree: PageTree): { down: boolean; up: boolean } {
  return { down: tree.scroll.top + 1 < tree.scroll.maxTop, up: tree.scroll.top > 0 };
}

/**
 * The regions and headings an element's line is under, outermost first ("dialog Destination › search"), and the text
 * lines under its nearest region.
 */
export function contextOf(tree: PageTree, element: number): { path: string[]; nearby: string[] } {
  const at = tree.lines.findIndex((line) => line.line.kind === "element" && line.line.element === element);
  if (at < 0) return { path: [], nearby: [] };
  const path: string[] = [];
  for (let parent = tree.lines[at]!.parent; parent !== undefined; parent = tree.lines[parent]!.parent) {
    const line = tree.lines[parent]!.line;
    if (line.kind === "region") path.push(line.name === "" ? line.role : `${line.role} ${line.name}`);
  }
  path.reverse();
  const region = tree.lines[at]!.parent;
  for (let before = at - 1; before >= 0 && tree.lines[before]!.parent === region; before -= 1) {
    const line = tree.lines[before]!.line;
    if (line.kind === "heading") {
      path.push(`${HEADING_ROLE} ${line.name}`);
      break;
    }
  }
  const nearby: string[] = [];
  for (const line of tree.lines) {
    if (line.parent === region && line.line.kind === "text") nearby.push(line.line.text);
  }
  return { path, nearby };
}

/** The reading's switches: how the tree is built and what the state carries. */
export interface ReadingSettings {
  /** Regions nest as a tree (banner, search, form, dialog …); off: every line at the top level. */
  regionTree: boolean;
  /** Text lines sit in the tree where the page has them. */
  textInTree: boolean;
  /** The tree is cut into three parts, viewport, above and below. */
  viewportParts: boolean;
  /** A structure node with no name of its own gives way to its children. */
  mergeStructure: boolean;
  /** Text that only repeats the name of the element it is in is left out. */
  dropNameText: boolean;
  /** An element's option carries its role and name. */
  optionNames: boolean;
  /** On a page state seen before, an element acted on there says so. */
  triedMarks: boolean;
  /** The most options of one dropdown the tree lists under it. */
  selectOptionsListed: number;
  /** How many of the newest recent actions are packed right after the viewport's elements. */
  recentActionsFirst: number;
  /** How many recent actions are given at most. */
  recentActionsMax: number;
  /** The run's summary in the state. */
  runSummary: boolean;
  /** Areas the reading cannot read are reported where they are. */
  unreadableAreas: boolean;
}

/** What reads a page besides the capture: the reading's switches, and the boxes a secret was typed into. */
export interface ReadOptions {
  reading: ReadingSettings;
  /** The boxes a secret was typed into, each by its `secretKey`. */
  secrets: ReadonlySet<string>;
}

/** The page tree of a capture. */
export function readPage(capture: PageCapture, options: ReadOptions): PageTree {
  const dom = capturedDom(capture);
  readGeneratedContent(capture, dom.nodes);
  const viewport = { x: 0, y: 0, w: capture.viewport.w, h: capture.viewport.h };
  const reader = new Reader(dom.nodes, viewport, options, URL.parse(dom.url) ?? undefined);
  const tree: PageTree = {
    url: dom.url,
    title: dom.title,
    scroll: capture.scroll,
    viewport,
    elements: [],
    lines: [],
    changing: new Set(),
  };
  const drafts = dom.nodes.length > 0 ? reader.walk(0, NO_CLIPS, false) : [];
  layOut(drafts, tree, { next: PAGE_NUMBER + 1 }, 0, undefined, [], options.reading);
  return tree;
}

/**
 * A node of the tree before it is numbered and laid out in lines; `changing` when it is part of what changes on the page
 * by itself (`changingOf`).
 */
type Draft =
  | { kind: "region"; role: string; name: string; children: Draft[]; changing?: boolean }
  | { kind: "heading"; name: string; part: Part; changing?: boolean }
  /** A run of text; `marker` when it is a list item's bullet or number. */
  | { kind: "text"; text: string; part: Part; rect: Rect; marker: boolean; changing?: boolean }
  | { kind: "element"; element: Element; children: Draft[]; changing?: boolean }
  | { kind: "unreadable"; what: string; part: Part };

/** How much of a node changes by itself: all it holds, or its words alone (the controls it holds stay what they are). */
type Changing = "whole" | "words";

/** Whether a draft is, or holds, a numbered element. */
function numbered(draft: Draft): boolean {
  if (draft.kind === "element") return true;
  return draft.kind === "region" && draft.children.some(numbered);
}

/** What clips a node, as the browser clips it. */
interface Clips {
  /** What the boxes around it cut off. */
  around: Rect | undefined;
  /**
   * What an absolutely positioned box gets: the clipping of its containing block, the nearest positioned box (or
   * frame) around it, not that of the unpositioned boxes in between.
   */
  absolute: Rect | undefined;
}

const NO_CLIPS: Clips = { around: undefined, absolute: undefined };

/**
 * The clips of a box placed by `style`: a fixed box is placed against the view, whatever clips the boxes around it,
 * and so is an open popover, drawn over the page; an absolute one against its containing block.
 */
function clipsOf(clips: Clips, node: DomNode): Clips {
  if (node.attrs.has(POPOVER_ATTR)) return NO_CLIPS;
  switch (node.style?.position) {
    case "fixed":
      return NO_CLIPS;
    case "absolute":
      return { around: clips.absolute, absolute: clips.absolute };
    default:
      return clips;
  }
}

class Reader {
  private readonly nodes: readonly DomNode[];
  private readonly viewport: Rect;
  private readonly options: ReadOptions;
  private readonly base: URL | undefined;
  /** The nodes drawn over whole, not read (by index). */
  private readonly covered: ReadonlySet<number>;
  /** Where each node shows, clipped (by index). */
  private readonly shown: (Rect | undefined)[];
  /** Each node's document (by index), and the labels of each control a label names. */
  private readonly documents: number[];
  private readonly labels: Map<number, number[]>;
  /** The nodes by what binds an element to them: its frame's target and its backend node id. */
  private readonly byBinding = new Map<string, number>();

  constructor(nodes: readonly DomNode[], viewport: Rect, options: ReadOptions, base: URL | undefined) {
    this.nodes = nodes;
    this.viewport = viewport;
    this.options = options;
    this.base = base;
    this.documents = documentsOf(nodes);
    this.labels = labelsOf(nodes);
    for (const node of nodes) this.byBinding.set(secretKey(node.target, node.backendNodeId), node.index);
    this.shown = new Array(nodes.length).fill(undefined);
    if (nodes.length > 0) this.clipAll(0, NO_CLIPS);
    this.covered = coveredByPaint(nodes, this.shown, this.documents, this.labels);
  }

  /** The drafts of a node and what it holds (`walkNode`), marked when the page says they change by themselves. */
  walk(index: number, around: Clips, parentPointer: boolean): Draft[] {
    const drafts = this.walkNode(index, around, parentPointer);
    const changing = changingOf(this.nodes[index]!);
    return changing === undefined ? drafts : markChanging(drafts, changing);
  }

  /** The drafts of a node and what it holds: a node that is no line of its own gives its children's. */
  private walkNode(index: number, around: Clips, parentPointer: boolean): Draft[] {
    const node = this.nodes[index]!;
    if (isText(node)) {
      const text = this.textOf(node, around.around);
      return text ? [text] : [];
    }
    if (!isElement(node)) return node.children.flatMap((child) => this.walk(child, around, parentPointer));
    if (SKIPPED_TAGS.includes(node.tag)) return [];
    const style = node.style;
    // Not rendered, hidden, or inert: no person sees or uses it.
    if (style?.display === "none" || node.ax?.hidden || node.attrs.has(INERT_ATTR)) return [];
    const clips = clipsOf(around, node);
    // Behind an open modal dialog: nothing of its own is read or offered, but it may hold the dialog (the browser
    // puts the dialog's ancestors behind it as well), so the elements it holds are walked.
    if (node.behindModal) {
      return node.children
        .filter((child) => !isText(this.nodes[child]!))
        .flatMap((child) => this.walk(child, clips, parentPointer));
    }
    const drawn = (style?.visible() ?? true) && !this.covered.has(index);
    const shown = drawn && node.rect ? visibleRect(node.rect, clips.around) : undefined;
    const part = shown ? this.partOf(shown) : undefined;
    const pointer = style?.cursor === "pointer";
    const ownPointer = pointer && !parentPointer;
    const scrollBox = node.scrollBox;
    const scrolls =
      scrollBox && scrollBox.scrollHeight > scrollBox.clientHeight + SCROLL_SLACK_PX && style?.scrolls()
        ? scrollBox
        : undefined;
    const childClips = this.clipsInside(node, clips);
    const role = this.roleOf(node);
    const name = collapse(this.nameOf(node));
    const held = () => node.children.flatMap((child) => this.walk(child, childClips, pointer));
    // A frame the page hides draws nothing of its document, which visibility does not pass into: that document's own
    // styles say it is visible (hCaptcha keeps its challenge so, above the page, until it asks something).
    if (node.tag === IFRAME_TAG && !(style?.visible() ?? true)) return [];
    if (node.tag === IFRAME_TAG && node.children.length === 0) {
      return part && this.options.reading.unreadableAreas
        ? [{ kind: "unreadable", what: this.frameLabel(node), part }]
        : [];
    }
    if (node.tag === CANVAS_TAG) {
      return part && this.options.reading.unreadableAreas ? [{ kind: "unreadable", what: CANVAS_TAG, part }] : [];
    }
    if (role === LIST_MARKER_ROLE) {
      // A list item's bullet or number, drawn by the browser: words of the item, no target of its own.
      return part && name !== ""
        ? [{ kind: "text", text: name, part, rect: shown ?? { ...NO_RECT }, marker: true }]
        : [];
    }
    if (role === HEADING_ROLE) {
      // A heading's words are its line; the controls drawn inside it (a result's title link, an accordion's
      // button) follow it, as a control's do.
      const heading: Draft[] = part ? [{ kind: "heading", name: cut(name, NAME_MAX_CHARS), part }] : [];
      return [...heading, ...heldControls(held(), undefined)];
    }
    if (node.tag === SELECT_TAG || CONTROL_ROLES.includes(role)) {
      // A control's words are its name: what it holds is listed only as a dropdown's options, the controls drawn
      // inside it and the words its name and value do not say.
      if (!shown || !part) {
        // A control not shown (covered, clipped away) is no target; the controls it holds may be.
        return heldControls(held(), undefined);
      }
      const element = this.elementOf(node, role, name, shown, part, false);
      const children = this.optionsOf(node, element, part);
      let changing = false;
      if (node.tag !== SELECT_TAG) {
        // The words a secret box holds are what was typed into it (an editable region keeps them as text): none
        // of them is written.
        const said =
          element.secretLength === undefined ? lettersAndDigits(element.name + (element.value ?? "")) : undefined;
        let inside = heldControls(held(), said);
        // A control the accessibility tree names nothing is named by its words; but the words in one that takes a
        // value are what it shows, not what it is. One that shows none (its icon alone) is named by the words it
        // hides: what its icon means.
        if (element.name === "" && !INPUT_ROLES.includes(role)) {
          const texts = inside.filter((draft) => draft.kind === "text");
          const controls = inside.filter((draft) => draft.kind !== "text");
          const absorbed = absorbText(element, texts);
          inside = [...absorbed.held, ...controls];
          changing = absorbed.changing;
          if (element.name === "") {
            element.name = cut(this.hiddenWords(index).join(" "), TEXT_MAX_CHARS);
            element.words = element.name !== "";
          }
        }
        children.push(...inside);
      }
      return [{ kind: "element", element, children, changing }];
    }
    const children = mergeLines(held());
    const inner = children.some(numbered);
    if (shown && part) {
      // In the viewport, what shows a fact; off the screen, only what a signal says takes a click.
      const signal = this.takesClicks(node, parentPointer, pointer, shown, inner);
      const viewport = part === "viewport";
      if (viewport && !signal && !ownPointer && role === LIST_ITEM_ROLE && name === "" && !ownWords(children)) {
        const count = children.filter(numbered).length;
        // A list item holding one element (a menu's link, a time slot's button) gives way to it.
        if (count === 1) return withoutMarkers(children);
        // One holding several (a result's card) is a line of its own, unnumbered, over them.
        if (count > 1) return [{ kind: "region", role, name, children: withoutMarkers(children) }];
      }
      // A box taking clicks, with no name, that holds a fact taking no click of its own, which a click on it
      // reaches, is no target of its own: that click goes up to it, so one thing has one number, named by its
      // words; the hand it shows is on the facts it holds. When a layer over its facts takes their clicks, it
      // stays the target.
      if (viewport && (signal || ownPointer) && name === "" && !scrolls && this.holdsAReachedFact(children)) {
        return factsPointed(children, ownPointer);
      }
      const isNumbered = viewport
        ? this.showsAFact(node, role, name, children, signal || ownPointer, ownPointer)
        : signal && !inner;
      if (isNumbered) {
        const element = this.elementOf(node, role, name, shown, part, signal && !viewport);
        element.keep = signal ? Keep.Clickable : Keep.Filled;
        element.pointer = ownPointer && viewport;
        // A pane in the viewport a person scrolls (its overflow scrolls, its content is taller) that takes no
        // click is one to scroll, its words its name.
        if (scrolls && viewport && !signal && !ownPointer && !isPageScroller(node) && style?.userScrolls()) {
          element.kind = scrollKind(scrolls);
          element.keep = Keep.Clickable;
        }
        const absorbed = absorbText(element, children);
        return [{ kind: "element", element, children: absorbed.held, changing: absorbed.changing }];
      }
      if (scrolls && viewport && !isPageScroller(node)) {
        const element = this.elementOf(node, role, name, shown, part, false);
        element.kind = scrollKind(scrolls);
        element.keep = Keep.Clickable;
        return [{ kind: "element", element, children }];
      }
    }
    if (this.options.reading.regionTree && isRegion(role, name)) return [{ kind: "region", role, name, children }];
    if (!this.options.reading.mergeStructure && children.length > 0 && GENERIC_ROLES.includes(axRole(node))) {
      return [{ kind: "region", role, name, children }];
    }
    return children;
  }

  /**
   * The clips a box passes on to what it holds: its box cuts them down on the axes its overflow is not visible on,
   * but for the page's own scroller (above and below are parts of the page) and a frame (its document scrolls inside
   * it); a positioned box or a frame is the containing block of the absolute boxes inside.
   */
  private clipsInside(node: DomNode, clips: Clips): Clips {
    const cuts = node.style?.clips() ?? { x: false, y: false };
    let around = clips.around;
    if (node.clientRect && (cuts.x || cuts.y) && node.tag !== IFRAME_TAG && !isPageScroller(node)) {
      const box = cutOn(node.clientRect, cuts.x, cuts.y);
      around = clips.around ? (overlap(clips.around, box) ?? { ...box, w: 0, h: 0 }) : box;
    }
    const contains = node.tag === IFRAME_TAG || (node.style?.positioned() ?? false);
    return { around, absolute: contains ? around : clips.absolute };
  }

  /**
   * Whether drafts hold a numbered fact taking no click of its own that a click on it reaches (not counting what a
   * numbered element holds).
   */
  private holdsAReachedFact(children: readonly Draft[]): boolean {
    return children.some((child) => {
      if (child.kind === "region") return this.holdsAReachedFact(child.children);
      if (child.kind !== "element" || child.element.keep !== Keep.Filled) return false;
      const { target, backendNodeId } = child.element.binding;
      const index = this.byBinding.get(secretKey(target, backendNodeId));
      return index !== undefined && this.reached(index);
    });
  }

  /**
   * Whether a click on a node lands on it: no boxes drawn over it from outside it and its labels, taking the
   * pointer (however clear: a press layer), hold where it shows.
   */
  private reached(index: number): boolean {
    const paint = this.nodes[index]!.paint;
    const rect = this.shown[index];
    if (paint === undefined || !rect) return false;
    const labels = this.labels.get(index) ?? [];
    const over = new BoxUnion(rect);
    for (const other of this.nodes) {
      const otherRect = this.shown[other.index];
      if (
        otherRect &&
        other.paint !== undefined &&
        other.paint > paint &&
        this.documents[other.index] === this.documents[index] &&
        (!other.style || (other.style.visible() && other.style.takesPointer())) &&
        overlap(otherRect, rect) &&
        !holds(this.nodes, index, other.index) &&
        !labels.some((label) => holds(this.nodes, label, other.index))
      ) {
        over.add(otherRect);
      }
    }
    return !over.holds(rect);
  }

  /** Where each node shows, clipped as `walk` clips it (by index; none for a node not drawn or wholly cut off). */
  private clipAll(index: number, around: Clips): void {
    const node = this.nodes[index]!;
    const clips = isElement(node) ? clipsOf(around, node) : around;
    this.shown[index] = node.rect ? visibleRect(node.rect, clips.around) : undefined;
    const inside = isElement(node) ? this.clipsInside(node, clips) : clips;
    for (const child of node.children) this.clipAll(child, inside);
  }

  /** A run of text, when it is drawn where a person sees it (not hidden, as a closed menu's words are). */
  private textOf(node: DomNode, clip: Rect | undefined): Draft | undefined {
    const text = collapse(node.text ?? "");
    if (text === "" || this.covered.has(node.index) || !(node.style?.visible() ?? true)) return undefined;
    const rect = node.rect ? visibleRect(node.rect, clip) : undefined;
    const part = rect ? this.partOf(rect) : undefined;
    return rect && part ? { kind: "text", text: cut(text, TEXT_MAX_CHARS), part, rect, marker: false } : undefined;
  }

  /** The words a node holds that are laid out but hidden, in page order (an inert part is no part of the page). */
  private hiddenWords(index: number): string[] {
    const node = this.nodes[index]!;
    if (isText(node)) {
      const text = collapse(node.text ?? "");
      const hidden = node.rect !== undefined && node.style !== undefined && !node.style.visible();
      return hidden && text !== "" ? [text] : [];
    }
    if (SKIPPED_TAGS.includes(node.tag) || node.attrs.has(INERT_ATTR)) return [];
    return node.children.flatMap((child) => this.hiddenWords(child));
  }

  /** Where a drawn box lies against the viewport; none when it is outside it to the side. */
  private partOf(rect: Rect): Part | undefined {
    const view = this.viewport;
    if (rect.y + rect.h <= view.y) return "above";
    if (rect.y >= view.y + view.h) return "below";
    return rect.x + rect.w > view.x && rect.x < view.x + view.w ? "viewport" : undefined;
  }

  /**
   * The role a node has: the accessibility tree's, or its markup's where the tree gives it none (it leaves out parts
   * of the page the browser has not laid out yet, and a control marked aria-hidden that a person still sees and uses).
   */
  private ownRole(node: DomNode): string {
    const role = axRole(node);
    return role === "" || GENERIC_ROLES.includes(role) ? (markupRole(node) ?? role) : role;
  }

  /**
   * The name a node has: the accessibility tree's; where the role is its markup's, the name its markup gives
   * (aria-label, alt, title).
   */
  private nameOf(node: DomNode): string {
    const name = node.ax?.name ?? "";
    const fromMarkup = markupRole(node) !== undefined && this.ownRole(node) !== axRole(node);
    if (name !== "" || !fromMarkup) return name;
    for (const attr of MARKUP_NAME_ATTRS) {
      const value = node.attrs.get(attr);
      if (value !== undefined && trim(value) !== "") return value;
    }
    return "";
  }

  /** The role a line writes: the node's own role; a native dropdown's own; a structure node's tag. */
  private roleOf(node: DomNode): string {
    if (node.tag === SELECT_TAG) return SELECT_ROLE;
    const role = this.ownRole(node);
    if (role === "" || GENERIC_ROLES.includes(role)) return node.tag;
    return role === "image" ? IMAGE_ROLE : role;
  }

  /**
   * Whether a drawn element in the viewport with no control role is numbered: any box but a run of text inside a
   * line, an image without a name no hand is shown on, and a wrapper: a box with no role (or an unnamed structure
   * role) or name of its own, no text of its own on the screen and no click signal, whose elements take its place.
   * A region stays a region.
   */
  private showsAFact(
    node: DomNode,
    role: string,
    name: string,
    children: readonly Draft[],
    signal: boolean,
    ownPointer: boolean,
  ): boolean {
    if (isRegion(role, name)) return false;
    if (IMAGE_ROLES.includes(role) && name === "") return ownPointer;
    const ownRole = this.ownRole(node);
    // A structure role without a name (a list, a card, a group) is structure as a box with no role is.
    const generic = ownRole === "" || GENERIC_ROLES.includes(ownRole);
    const textOnly = children.length === 1 && children[0]!.kind === "text";
    const inline = node.style?.display === INLINE_DISPLAY;
    // A run of text inside a line is text; one with a role of its own (a group, a list) is no mere run.
    if (generic && inline && textOnly && !signal) return false;
    // An unnamed structure role gives way only to what is numbered inside it: one holding nothing numbered is the
    // target itself.
    const structure = name === "" && NAMED_REGION_ROLES.includes(ownRole) && children.some(numbered);
    const wrapper = (generic || structure) && name === "" && !signal && !ownWords(children);
    return !wrapper;
  }

  /**
   * Whether a box with no control role takes a click: the snapshot says it does (a link or click listeners), it
   * shows the hand cursor and its parent does not, or it is a tab stop. A layer over most of the page does not count
   * when it holds what is numbered or the pointer passes through it.
   */
  private takesClicks(node: DomNode, parentPointer: boolean, pointer: boolean, rect: Rect, inner: boolean): boolean {
    const area = this.viewport.w * this.viewport.h;
    const layer = area > 0 && rect.w * rect.h >= area * OVERLAY_SHARE;
    if (layer && (inner || (node.style !== undefined && !node.style.takesPointer()))) return false;
    const tabindex = node.attrs.get("tabindex");
    const tabStop =
      Boolean(node.ax?.props.get("focusable")) && (tabindex === undefined || (integer(trim(tabindex)) ?? -1n) >= 0n);
    return node.clickable === true || (pointer && !parentPointer) || tabStop;
  }

  private elementOf(node: DomNode, role: string, name: string, rect: Rect, part: Part, signal: boolean): Element {
    const binding = { session: node.session, target: node.target, backendNodeId: node.backendNodeId };
    const props = node.ax?.props;
    const flag = (key: string) => yes(props?.get(key));
    const states: ElementState[] = [];
    for (const key of STATE_PROPS) {
      // A closed dropdown says it is not expanded, always: nothing a step needs.
      if ((key === "expanded" && node.tag === SELECT_TAG) || !props?.has(key)) continue;
      const value = props.get(key);
      if (key === "expanded") states.push([key, String(value)]);
      else if (key === "checked" && value === "mixed") states.push([key, "mixed"]);
      else if (flag(key)) states.push([key, undefined]);
    }
    const secret =
      sameButAsciiCase(node.attrs.get("type") ?? "", PASSWORD_TYPE) ||
      this.options.secrets.has(secretKey(binding.target, binding.backendNodeId));
    const input = INPUT_ROLES.includes(role) && node.tag !== SELECT_TAG;
    const held = node.value ?? node.ax?.value;
    let kind: ElementKind;
    if (node.tag === SELECT_TAG) kind = { kind: "select", options: this.selectOptions(node) };
    else if (input) kind = { kind: "input", readonly: flag("readonly") || node.attrs.has("readonly") };
    // A chosen radio button: clicking it again does nothing.
    else if (role === "radio" && flag("checked")) kind = { kind: "shown" };
    else kind = { kind: "click" };
    const href = role === "link" ? node.attrs.get("href") : undefined;
    return {
      number: 0,
      binding,
      role,
      axRole: axRole(node),
      axName: node.ax?.name ?? "",
      name,
      states,
      value: input && !secret ? (held ?? "") : undefined,
      secretLength: input && secret ? length(held ?? "") : undefined,
      href: href === undefined ? undefined : this.hrefOf(href),
      clickable: signal && !CONTROL_ROLES.includes(role),
      pointer: false,
      words: false,
      disabled: flag("disabled"),
      kind,
      keep: kind.kind === "input" || kind.kind === "select" ? Keep.Fillable : Keep.Clickable,
      part,
      rect,
    };
  }

  /** The `<option>`s of a native dropdown (inside `<optgroup>`s too), in page order. */
  private optionNodes(node: DomNode): DomNode[] {
    const found: DomNode[] = [];
    const stack = node.children.toReversed();
    while (stack.length > 0) {
      const child = this.nodes[stack.pop()!]!;
      if (child.tag === OPTION_TAG) found.push(child);
      else if (isElement(child)) stack.push(...child.children.toReversed());
    }
    return found;
  }

  /** A native dropdown's options, by live index. */
  private selectOptions(node: DomNode): SelectOption[] {
    return this.optionNodes(node).map((option, index) => {
      const text = collapse(this.textWithin(option));
      return {
        index,
        text,
        value: option.attrs.get("value") ?? text,
        selected: option.selected === true,
        disabled: option.attrs.has("disabled"),
      };
    });
  }

  /**
   * A native dropdown's options as lines under it, as many as the switch lists around the selected one; the selected
   * one's text is the dropdown's value.
   */
  private optionsOf(node: DomNode, element: Element, part: Part): Draft[] {
    if (element.kind.kind !== "select") return [];
    const options = element.kind.options;
    const window = optionsWindow(options, Math.max(this.options.reading.selectOptionsListed, 0));
    const optionNodes = this.optionNodes(node);
    return options.slice(window.start, window.end).map((option) => {
      const optionNode = optionNodes[option.index]!;
      const states: ElementState[] = [];
      if (option.selected) states.push(["selected", undefined]);
      if (option.disabled) states.push(["disabled", undefined]);
      const listed: Element = {
        number: 0,
        binding: { session: optionNode.session, target: optionNode.target, backendNodeId: optionNode.backendNodeId },
        role: OPTION_TAG,
        axRole: OPTION_TAG,
        axName: option.text,
        name: option.text,
        states,
        value: undefined,
        secretLength: undefined,
        href: undefined,
        clickable: false,
        pointer: false,
        words: false,
        disabled: option.disabled,
        kind: { kind: "shown" },
        keep: Keep.Fillable,
        part,
        rect: element.rect,
      };
      return { kind: "element", element: listed, children: [] } satisfies Draft;
    });
  }

  /**
   * A node's text as `textContent` gives it: its text nodes one after another, nothing put between them (an option
   * written "12", ":", "00" says "12:00", as the page's own check of it reads it).
   */
  private textWithin(node: DomNode): string {
    let text = "";
    const stack = [node.index];
    while (stack.length > 0) {
      const child = this.nodes[stack.pop()!]!;
      if (isText(child)) text += child.text ?? "";
      stack.push(...child.children.toReversed());
    }
    return text;
  }

  /** A frame's line: its host. */
  private frameLabel(node: DomNode): string {
    const src = node.attrs.get("src");
    const host = src !== undefined && this.base ? resolve(src, this.base)?.hostname : undefined;
    return host ? `${IFRAME_TAG} ${host}` : IFRAME_TAG;
  }

  /**
   * A link's address as the line writes it: the path on this site, the host and path on another; a `tel:` or
   * `mailto:` address as written.
   */
  private hrefOf(written: string): string | undefined {
    const href = trim(written);
    if (href === "" || href.startsWith("#") || href.startsWith("javascript:")) return undefined;
    const url = resolve(href, this.base);
    if (!url) return undefined;
    if (!WEB_PROTOCOLS.includes(url.protocol)) return url.href;
    return this.base?.hostname === url.hostname ? url.pathname : `${url.hostname}${url.pathname}`;
  }
}

/** An address as the lines write it: its protocol, its host, its path, and the whole of it. */
interface Address {
  protocol: string;
  hostname: string;
  pathname: string;
  href: string;
}

/**
 * The address a written reference names on a page at `base`, as the reader the model was trained with resolves it,
 * where that differs from a browser:
 * - a reference that names no host ("//" and then another slash) names no address (a browser skips the extra
 *   slashes), and its link is written without one;
 * - a caret stays a caret (a browser writes it as %5E in a path).
 */
function resolve(reference: string, base: URL | undefined): Address | undefined {
  let start = 0;
  while (start < reference.length && reference.charCodeAt(start) <= LAST_DROPPED_CODE) start += 1;
  if (base && HOSTLESS_REFERENCE.test(reference.slice(start))) return undefined;
  // The caret goes through the parser as a character it escapes in every part alike, and is put back after.
  const stands = reference.includes(CARET) && !reference.includes(CARET_STAND_IN);
  const url = URL.parse(stands ? reference.replaceAll(CARET, CARET_STAND_IN) : reference, base);
  if (!url) return undefined;
  const written = (part: string) => (stands ? part.replaceAll(CARET_ESCAPED, CARET) : part);
  return { protocol: url.protocol, hostname: url.hostname, pathname: written(url.pathname), href: written(url.href) };
}

function axRole(node: DomNode): string {
  return node.ax?.role ?? "";
}

function isRegion(role: string, name: string): boolean {
  return REGION_ROLES.includes(role) || (NAMED_REGION_ROLES.includes(role) && name !== "");
}

/** Whether it is the document's own scroller, which the page's number scrolls. */
function isPageScroller(node: DomNode): boolean {
  return PAGE_SCROLLER_TAGS.includes(node.tag);
}

/**
 * Which of a dropdown's options it lists: `listed` of them around the selected one (from the first when none is), so
 * the value it holds is always among them.
 */
export function optionsWindow(options: readonly SelectOption[], most: number): { start: number; end: number } {
  const listed = Math.min(most, options.length);
  const selected = Math.max(
    options.findIndex((option) => option.selected),
    0,
  );
  const start = Math.min(Math.max(selected - Math.floor(listed / 2), 0), options.length - listed);
  return { start, end: start + listed };
}

/**
 * What a control or a heading holds, however deep: the controls drawn inside it, with the regions they are in; and,
 * for a control, the words it holds that `said` (its name and value, by their letters and digits) does not say, as
 * lines under it (a heading's words are its name). An element inside it that only fills the viewport up is no target
 * of its own: its words are such words, and the controls it holds are still listed.
 */
function heldControls(drafts: Draft[], said: string | undefined): Draft[] {
  const held: Draft[] = [];
  for (const draft of drafts) {
    if (draft.kind === "element" && draft.element.keep === Keep.Filled) {
      const { name, part, rect } = draft.element;
      held.push({
        kind: "text",
        text: name,
        part,
        rect: { ...rect },
        marker: false,
        changing: draft.changing === true,
      });
      held.push(...heldControls(draft.children, said));
    } else if (draft.kind === "region") {
      if (draft.children.some(numbered)) held.push(draft);
      else held.push(...heldControls(draft.children, said));
    } else if (draft.kind !== "unreadable") {
      held.push(draft);
    }
  }
  return mergeLines(
    held.filter((draft) => {
      if (draft.kind === "text") return said !== undefined && !saidAlready(draft.text, said);
      if (draft.kind === "heading") return said !== undefined && !saidAlready(draft.name, said);
      return true;
    }),
  );
}

/** A text's letters and digits, lower-cased: what it says, whatever its spaces, punctuation and icon glyphs. */
function lettersAndDigits(text: string): string {
  let said = "";
  for (const character of text) {
    if (LETTER_OR_DIGIT.test(character)) said += character.toLowerCase();
  }
  return said;
}

/** Whether `said` already says what a text does, or the text says nothing (a bullet, an icon font's glyph). */
function saidAlready(text: string, said: string): boolean {
  const told = lettersAndDigits(text);
  return told === "" || said.includes(told);
}

/**
 * The role a node's markup gives it: its role attribute, else its control tag's (and an input's type's); none for
 * another tag (an image inside a clickable box stays a picture, not the box's target).
 */
function markupRole(node: DomNode): string | undefined {
  const written = words(node.attrs.get("role") ?? "")[0];
  if (written !== undefined) return written;
  switch (node.tag) {
    case "a":
      return node.attrs.has("href") ? "link" : undefined;
    case "button":
    case "summary":
      return "button";
    case "textarea":
      return "textbox";
    case "input": {
      const type = asciiLower(node.attrs.get("type") ?? "text");
      return ROLELESS_INPUT_TYPES.includes(type) ? undefined : (INPUT_TYPE_ROLES.get(type) ?? "textbox");
    }
    default:
      return undefined;
  }
}

/** The role of each input type that is no text box. */
const INPUT_TYPE_ROLES = new Map<string, string>([
  ["button", "button"],
  ["submit", "button"],
  ["reset", "button"],
  ["image", "button"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["range", "slider"],
  ["number", "spinbutton"],
  ["search", "searchbox"],
  ["date", "Date"],
  ["datetime-local", "DateTime"],
  ["time", "InputTime"],
]);
/** The input types that are no control a person operates through the page. */
const ROLELESS_INPUT_TYPES = ["hidden", "file", "color"];

/** The clip a box makes on the axes it cuts; on an axis it does not, the clip reaches as far as a page can. */
function cutOn(client: Rect, x: boolean, y: boolean): Rect {
  return {
    x: x ? client.x : -UNCUT_PX,
    y: y ? client.y : -UNCUT_PX,
    w: x ? client.w : 2 * UNCUT_PX,
    h: y ? client.h : 2 * UNCUT_PX,
  };
}

/** What of a box shows inside the boxes that clip it (a box of its own); none when nothing does. */
function visibleRect(rect: Rect, clip: Rect | undefined): Rect | undefined {
  if (rect.w <= 0 || rect.h <= 0) return undefined;
  return clip ? overlap(rect, clip) : { ...rect };
}

/**
 * Whether two accessible names are the same name: compared as flat strings, white space collapsed to single spaces
 * and trimmed. A page may give a name with spaces around it, which the reading trims.
 */
export function sameName(a: string, b: string): boolean {
  return collapse(a) === collapse(b);
}

/**
 * The nodes the opaque boxes drawn after them cover whole: in each document, from the last painted back, a node is
 * covered when the opaque boxes painted after it hold its box; boxes painted at the same step do not cover each
 * other. Only what is drawn takes part. A box is opaque by the alpha of its background whatever the colour, and by
 * its opacity with those of the boxes around it multiplied in. And only what takes a person's click hides: each box
 * counts where it shows, a box the pointer passes through hides nothing, nor one a clip shape cuts, and a node is
 * hidden only by boxes from outside it and its labels.
 */
function coveredByPaint(
  nodes: readonly DomNode[],
  shown: readonly (Rect | undefined)[],
  documents: readonly number[],
  labels: ReadonlyMap<number, number[]>,
): Set<number> {
  const opacities = opacitiesOf(nodes);
  const painted: { index: number; paint: number; rect: Rect }[] = [];
  for (const node of nodes) {
    const rect = shown[node.index];
    if ((node.style?.drawn() ?? true) && node.paint !== undefined && rect && rect.w > 0 && rect.h > 0) {
      painted.push({ index: node.index, paint: node.paint, rect });
    }
  }
  painted.sort((a, b) => b.paint - a.paint);
  let area: Rect | undefined;
  for (const { rect } of painted) {
    if (!area) {
      area = rect;
      continue;
    }
    const x = Math.min(area.x, rect.x);
    const y = Math.min(area.y, rect.y);
    area = {
      x,
      y,
      w: Math.max(area.x + area.w, rect.x + rect.w) - x,
      h: Math.max(area.y + area.h, rect.y + rect.h) - y,
    };
  }
  const hides = (index: number) => {
    const style = nodes[index]!.style;
    return style?.background() && style.takesPointer() && !style.shaped() && opacities[index]! >= OPAQUE_FROM;
  };
  const unions = new Map<number, BoxUnion>();
  const covered = new Set<number>();
  for (let from = 0; from < painted.length; ) {
    let to = from + 1;
    while (to < painted.length && painted[to]!.paint === painted[from]!.paint) to += 1;
    const step = painted.slice(from, to);
    for (const { index, rect } of step) {
      if (unions.get(documents[index]!)?.holds(rect)) covered.add(index);
    }
    for (const { index, rect } of step) {
      if (!hides(index)) continue;
      let union = unions.get(documents[index]!);
      if (!union) {
        union = new BoxUnion(area ?? NO_RECT);
        unions.set(documents[index]!, union);
      }
      union.add(rect);
    }
    from = to;
  }
  // What the union holds may be held by boxes of its own: weighed again against the others alone.
  const hiding = painted.filter(({ index }) => hides(index));
  for (const index of [...covered]) {
    const paint = nodes[index]!.paint;
    const rect = shown[index];
    if (paint === undefined || !rect) continue;
    const own = labels.get(index) ?? [];
    const outside = new BoxUnion(rect);
    for (const other of hiding) {
      if (
        other.paint > paint &&
        documents[other.index] === documents[index] &&
        overlap(other.rect, rect) &&
        !holds(nodes, index, other.index) &&
        !own.some((label) => holds(nodes, label, other.index))
      ) {
        outside.add(other.rect);
      }
    }
    if (!outside.holds(rect)) covered.delete(index);
  }
  return covered;
}

/** The labels of each control a label names (by index): the label around it, and those naming its id. */
function labelsOf(nodes: readonly DomNode[]): Map<number, number[]> {
  const byId = new Map<string, number>();
  const key = (target: string, id: string) => `${target} ${id}`;
  for (const node of nodes) {
    const id = node.attrs.get("id");
    if (id !== undefined) byId.set(key(node.target, id), node.index);
  }
  const labels = new Map<number, number[]>();
  const name = (control: number, label: number) => {
    const named = labels.get(control);
    if (named) named.push(label);
    else labels.set(control, [label]);
  };
  for (const label of nodes) {
    if (label.tag !== LABEL_TAG) continue;
    const named = label.attrs.get("for");
    const control = named === undefined ? undefined : byId.get(key(label.target, named));
    if (control !== undefined) name(control, label.index);
    const inside = [...label.children];
    while (inside.length > 0) {
      const at = inside.pop()!;
      if (LABELLED_TAGS.includes(nodes[at]!.tag)) name(at, label.index);
      inside.push(...nodes[at]!.children);
    }
  }
  return labels;
}

/** A node's parent, when the list has it. */
function parentOf(nodes: readonly DomNode[], index: number): number | undefined {
  const parent = nodes[index]!.parent;
  return parent >= 0 && parent < nodes.length ? parent : undefined;
}

/** Whether `outer` holds `inner`: is it, or one of the boxes around it. */
function holds(nodes: readonly DomNode[], outer: number, inner: number): boolean {
  let at: number | undefined = inner;
  // A parent chain longer than the nodes runs in a circle: what it reached is held by nothing more.
  for (let steps = 0; steps <= nodes.length && at !== undefined; steps += 1) {
    if (at === outer) return true;
    at = parentOf(nodes, at);
  }
  return false;
}

/**
 * Each node's opacity with those of the boxes around it multiplied in, as the page is composed: a layer's opacity
 * fades all it holds.
 */
function opacitiesOf(nodes: readonly DomNode[]): number[] {
  const opacities: (number | undefined)[] = new Array(nodes.length).fill(undefined);
  for (let index = 0; index < nodes.length; index += 1) {
    const chain: number[] = [];
    let above = 1;
    for (let at: number | undefined = index; at !== undefined; at = parentOf(nodes, at)) {
      const known = opacities[at];
      if (known !== undefined) {
        above = known;
        break;
      }
      chain.push(at);
      // A parent chain longer than the nodes runs in a circle: what it reached is faded by nothing more.
      if (chain.length > nodes.length) break;
    }
    for (const node of chain.reverse()) {
      above *= nodes[node]!.style?.ownOpacity() ?? 1;
      opacities[node] = above;
    }
  }
  return opacities.map((opacity) => opacity ?? 1);
}

/** Each node's document, by the index of its root: paint orders compare only within one. */
function documentsOf(nodes: readonly DomNode[]): number[] {
  const documents: (number | undefined)[] = new Array(nodes.length).fill(undefined);
  for (let index = 0; index < nodes.length; index += 1) {
    const chain: number[] = [];
    let at = index;
    let root: number;
    for (;;) {
      const known = documents[at];
      if (known !== undefined) {
        root = known;
        break;
      }
      chain.push(at);
      const parent = parentOf(nodes, at);
      // A parent chain longer than the nodes runs in a circle: what it reached is its own document.
      if (nodes[at]!.documentRoot || chain.length > nodes.length || parent === undefined) {
        root = at;
        break;
      }
      at = parent;
    }
    for (const node of chain) documents[node] = root;
  }
  return documents.map((root, index) => root ?? index);
}

/** A scroll area's kind: whether it scrolls further down and back up. */
function scrollKind(scroll: ScrollBox): ElementKind {
  return {
    kind: "scroll",
    down: scroll.scrollTop + scroll.clientHeight + SCROLL_SLACK_PX < scroll.scrollHeight,
    up: scroll.scrollTop > 0,
  };
}

/** Whether there are words of a box's own on the screen among what it holds: a list item's bullet alone is none. */
function ownWords(children: readonly Draft[]): boolean {
  return children.some((child) => child.kind === "text" && child.part === "viewport" && !child.marker);
}

/** The drafts of a box that gives way to the facts it holds, those facts marked with the hand it shows. */
function factsPointed(children: Draft[], pointer: boolean): Draft[] {
  for (const child of children) {
    if (child.kind === "element" && child.element.keep === Keep.Filled) child.element.pointer ||= pointer;
    else if (child.kind === "region") factsPointed(child.children, pointer);
  }
  return children;
}

/** What a list item holds but its bullet or number, which means nothing without the item. */
function withoutMarkers(children: Draft[]): Draft[] {
  return children.filter((child) => !(child.kind === "text" && child.marker));
}

/** Runs of text drawn on one line, next to each other, as one line. */
function mergeLines(children: Draft[]): Draft[] {
  const merged: Draft[] = [];
  for (const child of children) {
    const last = merged.at(-1);
    if (last?.kind === "text" && child.kind === "text" && last.part === child.part) {
      const sameLine = Math.abs(last.rect.y - child.rect.y) < Math.min(last.rect.h, child.rect.h) / 2;
      if (sameLine) {
        last.text = `${last.text} ${child.text}`;
        last.rect.w = Math.max(child.rect.x + child.rect.w - last.rect.x, last.rect.w);
        last.marker &&= child.marker;
        if (child.changing) last.changing = true;
        continue;
      }
    }
    merged.push(child);
  }
  return merged;
}

/**
 * An element with no name of its own that holds only text takes the text as its name: what it holds then (nothing),
 * and whether a text it took changes by itself (its name then does); else what it holds, as it is.
 */
function absorbText(element: Element, children: Draft[]): { held: Draft[]; changing: boolean } {
  if (element.name !== "" || children.length === 0) return { held: children, changing: false };
  const texts: string[] = [];
  let changing = false;
  for (const child of children) {
    if (child.kind !== "text") return { held: children, changing: false };
    texts.push(child.text);
    changing ||= child.changing === true;
  }
  element.name = texts.join(" ");
  element.words = true;
  return { held: [], changing };
}

/** How much of a node changes by itself, as the page marks it; undefined for a node the page does not mark so. */
function changingOf(node: DomNode): Changing | undefined {
  if (!isElement(node)) return undefined;
  const says = (prop: string, attr: string, values: readonly string[]) => {
    const value = node.ax?.props.get(prop) ?? node.attrs.get(attr);
    return typeof value === "string" && values.includes(asciiLower(trim(value)));
  };
  const roles = [axRole(node), markupRole(node)];
  const carousel = says(ROLE_DESCRIPTION_PROP, ROLE_DESCRIPTION_ATTR, CAROUSEL_DESCRIPTIONS);
  if (carousel || node.tag === MARQUEE || roles.includes(MARQUEE)) return "whole";
  const wordsRole = roles.some((role) => role !== undefined && CHANGING_WORDS_ROLES.includes(role));
  return wordsRole || says(LIVE_PROP, LIVE_ATTR, LIVE_VALUES) ? "words" : undefined;
}

/**
 * Drafts marked as part of what changes on the page by itself, `how` much of them: all, or all but the controls among
 * them (a live region holding results keeps their links), what those hold marked all the same.
 */
function markChanging(drafts: Draft[], how: Changing): Draft[] {
  for (const draft of drafts) {
    if (draft.kind === "unreadable") continue;
    const control =
      draft.kind === "element" && (CONTROL_ROLES.includes(draft.element.role) || draft.element.role === SELECT_ROLE);
    if (how === "whole" || !control) draft.changing = true;
    if (draft.kind === "region" || draft.kind === "element") markChanging(draft.children, how);
  }
  return drafts;
}

/**
 * Lays drafts out as lines in page order, numbering the elements, the regions' names on the stack (text that only
 * repeats one of them is left out).
 */
function layOut(
  given: Draft[],
  tree: PageTree,
  numbers: { next: number },
  depth: number,
  parent: number | undefined,
  names: string[],
  reading: ReadingSettings,
): void {
  const drafts = reading.dropNameText ? dropLabelTexts(given) : given;
  for (const draft of drafts) {
    switch (draft.kind) {
      case "region": {
        const part = firstPart(draft.children);
        if (!part) continue;
        const index = tree.lines.length;
        if (draft.changing) tree.changing.add(index);
        const line: Line = { kind: "region", role: draft.role, name: cut(draft.name, NAME_MAX_CHARS) };
        tree.lines.push({ line, depth, part, parent });
        names.push(draft.name);
        layOut(draft.children, tree, numbers, depth + 1, index, names, reading);
        names.pop();
        break;
      }
      case "heading":
        if (draft.changing) tree.changing.add(tree.lines.length);
        tree.lines.push({ line: { kind: "heading", name: draft.name }, depth, part: draft.part, parent });
        break;
      case "text":
        if (reading.dropNameText && names.some((name) => sameButAsciiCase(name, draft.text))) continue;
        if (draft.changing) tree.changing.add(tree.lines.length);
        tree.lines.push({ line: { kind: "text", text: draft.text }, depth, part: draft.part, parent });
        break;
      case "unreadable":
        tree.lines.push({ line: { kind: "unreadable", what: draft.what }, depth, part: draft.part, parent });
        break;
      case "element": {
        draft.element.number = numbers.next;
        numbers.next += 1;
        const index = tree.elements.length;
        names.push(draft.element.name);
        tree.elements.push(draft.element);
        const line = tree.lines.length;
        if (draft.changing) tree.changing.add(line);
        tree.lines.push({ line: { kind: "element", element: index }, depth, part: draft.element.part, parent });
        layOut(draft.children, tree, numbers, depth + 1, line, names, reading);
        names.pop();
        break;
      }
    }
  }
}

/** Text right before or after an element that only repeats its name (the label it is named by) is left out. */
function dropLabelTexts(drafts: Draft[]): Draft[] {
  const nameOf = (draft: Draft | undefined) =>
    draft?.kind === "element" ? draft.element.name.toLowerCase() : undefined;
  return drafts.filter((draft, at) => {
    if (draft.kind !== "text") return true;
    const text = draft.text.toLowerCase();
    return nameOf(drafts[at - 1]) !== text && nameOf(drafts[at + 1]) !== text;
  });
}

/** The part of a region's first line: where the region shows first. */
function firstPart(drafts: readonly Draft[]): Part | undefined {
  for (const draft of drafts) {
    const part =
      draft.kind === "region" ? firstPart(draft.children) : draft.kind === "element" ? draft.element.part : draft.part;
    if (part) return part;
  }
  return undefined;
}
