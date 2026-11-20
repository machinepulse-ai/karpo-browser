/**
 * The page as the browser renders it, read in one pass per frame: Chrome's DOM snapshot (nodes, layout, the computed
 * styles the reading asks for, whether a node takes clicks, JavaScript listeners included) merged with its
 * accessibility tree by backend node id. No reading rule runs here: these are the browser's facts.
 */

import type { FrameCapture, Offset, PageCapture, RawSnapshot, StyleName } from "../contracts/capture.ts";
import { styleAt } from "../contracts/capture.ts";
import { has, integer, items, member, number, string } from "../json.ts";
import { decimal, trim } from "../text.ts";
import type { Rect } from "./geometry.ts";

/** `Node.ELEMENT_NODE`. */
export const ELEMENT_NODE = 1;
/** `Node.TEXT_NODE`. */
export const TEXT_NODE = 3;

/** The overflows that scroll on their axis. */
const SCROLLING_OVERFLOWS = ["auto", "scroll", "overlay"];
/** The overflows that cut content off on their axis without scrolling it. */
const CUTTING_OVERFLOWS = ["hidden", "clip"];
/** The colour functions whose last comma-separated part is the alpha. */
const ALPHA_LAST_FUNCTIONS = ["rgba", "hsla"];

/**
 * A node's computed style, as far as the reading reads it (`SNAPSHOT_STYLES`, each found by name in the capture's own
 * list; a page captured before a style was read has it empty).
 */
export class Style {
  readonly display: string;
  readonly visibility: string;
  readonly cursor: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly position: string;
  readonly backgroundColor: string;
  readonly opacity: string;
  readonly pointerEvents: string;
  readonly clipPath: string;

  constructor(read: (name: StyleName) => string) {
    this.display = read("display");
    this.visibility = read("visibility");
    this.cursor = read("cursor");
    this.overflowX = read("overflow-x");
    this.overflowY = read("overflow-y");
    this.position = read("position");
    this.backgroundColor = read("background-color");
    this.opacity = read("opacity");
    this.pointerEvents = read("pointer-events");
    this.clipPath = read("clip-path");
  }

  /** Whether the box draws at all: it is not hidden, nor wholly transparent (its own opacity 0). */
  drawn(): boolean {
    return this.visible() && this.ownOpacity() !== 0;
  }

  /** Whether the box is there to see and click, however clear: it is not hidden. */
  visible(): boolean {
    return this.visibility !== "hidden" && this.visibility !== "collapse";
  }

  /** Its own opacity: 1 where it was not read. */
  ownOpacity(): number {
    return decimal(trim(this.opacity)) ?? 1;
  }

  /** Whether it has a background colour that shows: one whose alpha is above 0, whatever the colour. */
  background(): boolean {
    return colorAlpha(this.backgroundColor) > 0;
  }

  /** Whether a clip shape cuts the box (`clip-path`): it draws, and takes clicks, only inside the shape. */
  shaped(): boolean {
    return this.clipPath !== "" && this.clipPath !== "none";
  }

  /** Whether the pointer stops at the box (its clicks are its own). */
  takesPointer(): boolean {
    return this.pointerEvents !== "none";
  }

  /**
   * Whether the box is a scroll area a step scrolls down: its overflow scrolls on the vertical axis, or hides what
   * the page's script scrolls into view.
   */
  scrolls(): boolean {
    return SCROLLING_OVERFLOWS.includes(this.overflowY) || this.overflowY === "hidden";
  }

  /** Whether a person scrolls the box: its overflow scrolls on the vertical axis. */
  userScrolls(): boolean {
    return SCROLLING_OVERFLOWS.includes(this.overflowY);
  }

  /**
   * On which axes the box cuts off what it holds outside it: those its overflow is not visible on. Overflow does
   * nothing on an inline box.
   */
  clips(): { x: boolean; y: boolean } {
    if (this.display === "inline") return { x: false, y: false };
    return { x: cutsOn(this.overflowX), y: cutsOn(this.overflowY) };
  }

  /** Whether the box is placed (anything but `static`): the containing block of the absolute boxes inside. */
  positioned(): boolean {
    return this.position !== "" && this.position !== "static";
  }
}

/**
 * A computed colour's alpha, 0 to 1: the last of `rgba(r, g, b, a)`, what follows the slash of
 * `color(srgb r g b / a)`; 1 when it gives none, 0 for `transparent` and for no colour read.
 */
export function colorAlpha(color: string): number {
  const text = trim(color);
  if (text === "" || text === "transparent") return 0;
  const open = text.indexOf("(");
  if (!text.endsWith(")") || open < 0) return 1;
  const name = text.slice(0, open);
  const inner = text.slice(open + 1, -1);
  const slash = inner.indexOf("/");
  let alpha: string;
  if (slash >= 0) alpha = inner.slice(slash + 1);
  else if (ALPHA_LAST_FUNCTIONS.includes(name)) alpha = inner.slice(inner.lastIndexOf(",") + 1);
  else return 1;
  alpha = trim(alpha);
  if (!alpha.endsWith("%")) return decimal(alpha) ?? 1;
  const percent = decimal(trim(alpha.slice(0, -1)));
  return percent === undefined ? 1 : percent / 100;
}

/** Whether an overflow cuts content off on its axis: it scrolls, or it hides or clips what is out of the box. */
function cutsOn(overflow: string): boolean {
  return SCROLLING_OVERFLOWS.includes(overflow) || CUTTING_OVERFLOWS.includes(overflow);
}

/** A box's own scrolling: how far down it is, how tall its content is, how tall the box shows. */
export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** What the accessibility tree says of a node. */
export interface AxFacts {
  role: string;
  name: string;
  value: string | undefined;
  /** Its properties by name; a property without a value is left out. */
  props: Map<string, unknown>;
  /** The tree leaves it out because a person neither sees nor reaches it: not rendered, hidden or inert. */
  hidden: boolean;
  /** The tree leaves it out because a modal dialog is open over it. */
  behindModal: boolean;
}

/** The reasons the accessibility tree leaves a node out because a person does not get it. */
const HIDDEN_REASONS = ["notRendered", "notVisible", "inertElement", "inertSubtree"];
/** The reason it leaves a node out because a modal dialog is open over it. */
const BEHIND_MODAL_REASON = "activeModalDialog";
/** The tags of CSS-generated content. */
const PSEUDO_TAGS = ["::before", "::after"];
/** The accessibility role of a run of text. */
const STATIC_TEXT_ROLE = "StaticText";

/** One node of the page, every frame's document in one list. */
export interface DomNode {
  index: number;
  /** Its parent's index, -1 for a root. */
  parent: number;
  children: number[];
  nodeType: number;
  tag: string;
  attrs: Map<string, string>;
  backendNodeId: number;
  /** The CDP session whose document holds the node, and its target (the page, or an out-of-process frame). */
  session: string;
  target: string;
  text?: string;
  value?: string;
  checked?: true;
  selected?: true;
  /** Chrome says it responds to clicks: a link, or JavaScript click listeners. */
  clickable?: true;
  /** The root of a document: one per frame document; its parent, when set, is the `<iframe>` that shows it. */
  documentRoot?: true;
  rect?: Rect;
  /** Laid out wholly left of or above its document's origin, where scrolling the document never goes. */
  beforeOrigin?: true;
  style?: Style;
  /** Its paint order within its own document: comparable only with nodes of the same document. */
  paint?: number;
  /** The content viewport inside the border, in the top-level viewport coordinates. */
  clientRect?: Rect;
  scrollBox?: ScrollBox;
  ax?: AxFacts;
  /** Behind an open modal dialog: the accessibility tree says so, or says nothing of it and its parent is. */
  behindModal: boolean;
}

export function isElement(node: DomNode): boolean {
  return node.nodeType === ELEMENT_NODE;
}

export function isText(node: DomNode): boolean {
  return node.nodeType === TEXT_NODE;
}

/** `strings[at]`, empty where there is none. */
function stringAt(strings: readonly string[], at: unknown): string {
  const index = integer(at);
  return index === undefined || index < 0 ? "" : (strings[index] ?? "");
}

/** A rare string list (`{ index, value }`) by node: the last one given for a node wins. */
function stringsAt(data: unknown, strings: readonly string[]): Map<number, string> {
  const values = items(member(data, "value"));
  const map = new Map<number, string>();
  items(member(data, "index")).forEach((node, i) => {
    const key = integer(node);
    if (key !== undefined) map.set(key, stringAt(strings, values[i]));
  });
  return map;
}

/** A rare number list (`{ index, value }`) by node, -1 where a value is missing. */
function numbersAt(data: unknown): Map<number, number> {
  const values = items(member(data, "value"));
  const map = new Map<number, number>();
  items(member(data, "index")).forEach((node, i) => {
    const key = integer(node);
    if (key !== undefined) map.set(key, number(values[i]) ?? -1);
  });
  return map;
}

/** A rare flag list (`{ index }`): the nodes it holds. */
function flagged(data: unknown): Set<number> {
  const nodes = new Set<number>();
  for (const node of items(member(data, "index"))) {
    const key = integer(node);
    if (key !== undefined) nodes.add(key);
  }
  return nodes;
}

/** Where each style the reading reads is in a layout node's list, found by name in the capture's own list. */
type StyleColumns = (name: StyleName) => number | undefined;

/**
 * One frame's snapshot as nodes appended to `out`, laid out in the page's viewport; returns its first document's
 * root.
 */
function readSnapshot(snapshot: RawSnapshot, out: DomNode[], frame: FrameCapture, columns: StyleColumns): number {
  const strings = snapshot.strings;
  const start: number[] = [];
  // Each iframe node and the index of the document it shows.
  const hosts: { host: number; shown: number }[] = [];
  for (const doc of snapshot.documents) {
    const nodes = member(doc, "nodes");
    const base = out.length;
    start.push(base);
    const text = stringsAt(member(nodes, "textValue"), strings);
    const input = stringsAt(member(nodes, "inputValue"), strings);
    const checked = flagged(member(nodes, "inputChecked"));
    const selected = flagged(member(nodes, "optionSelected"));
    const clickable = flagged(member(nodes, "isClickable"));
    const content = numbersAt(member(nodes, "contentDocumentIndex"));
    const parents = items(member(nodes, "parentIndex"));
    const attributes = items(member(nodes, "attributes"));
    const nodeTypes = items(member(nodes, "nodeType"));
    const nodeNames = items(member(nodes, "nodeName"));
    const nodeValues = items(member(nodes, "nodeValue"));
    const backendIds = items(member(nodes, "backendNodeId"));
    for (let i = 0; i < parents.length; i += 1) {
      const flat = items(attributes[i]);
      const attrs = new Map<string, string>();
      // A value index of -1 is an empty value (boolean attributes such as required).
      for (let a = 0; a + 1 < flat.length; a += 2) {
        const valueAt = number(flat[a + 1]);
        const value = valueAt !== undefined && valueAt >= 0 ? stringAt(strings, flat[a + 1]) : "";
        attrs.set(stringAt(strings, flat[a]).toLowerCase(), value);
      }
      const nodeType = integer(nodeTypes[i]) ?? 0;
      const name = stringAt(strings, nodeNames[i]);
      const parent = number(parents[i]);
      const node: DomNode = {
        index: base + i,
        parent: parent !== undefined && parent >= 0 ? base + Math.trunc(parent) : -1,
        children: [],
        nodeType,
        tag: nodeType === ELEMENT_NODE ? name.toLowerCase() : name,
        attrs,
        backendNodeId: integer(backendIds[i]) ?? 0,
        session: frame.session,
        target: frame.target ?? "",
        behindModal: false,
      };
      if (nodeType === TEXT_NODE) node.text = stringAt(strings, nodeValues[i]);
      const value = input.get(i) ?? text.get(i);
      if (value !== undefined) node.value = value;
      if (checked.has(i)) node.checked = true;
      if (selected.has(i)) node.selected = true;
      if (clickable.has(i)) node.clickable = true;
      const shown = content.get(i);
      if (shown !== undefined) hosts.push({ host: base + i, shown });
      if (i === 0) node.documentRoot = true;
      out.push(node);
    }
  }
  // Layout: a same-process child document sits where its iframe is drawn.
  const docOffset = new Map<number, Offset>([[0, frame.offset]]);
  snapshot.documents.forEach((doc, d) => {
    const layout = member(doc, "layout");
    const at = offsetOf(d, docOffset, hosts, out, frame.offset);
    const scrollX = number(member(doc, "scrollOffsetX")) ?? 0;
    const scrollY = number(member(doc, "scrollOffsetY")) ?? 0;
    const nodeIndex = items(member(layout, "nodeIndex"));
    const bounds = items(member(layout, "bounds"));
    const styles = items(member(layout, "styles"));
    const paints = member(layout, "paintOrders");
    const paintOrders = paints ? items(paints) : undefined;
    const scrollRects = items(member(layout, "scrollRects"));
    const clientRects = items(member(layout, "clientRects"));
    for (let l = 0; l < nodeIndex.length; l += 1) {
      const offset = integer(nodeIndex[l]);
      const node = offset === undefined ? undefined : out[start[d]! + offset];
      if (!node) continue;
      const bound = items(bounds[l]);
      const side = (k: number) => number(bound[k]) ?? 0;
      const [x, y, w, h] = [side(0), side(1), side(2), side(3)];
      const values = items(styles[l]);
      const rect = { x: x - scrollX + at.x, y: y - scrollY + at.y, w, h };
      node.rect = rect;
      if (x + w <= 0 || y + h <= 0) node.beforeOrigin = true;
      node.style = new Style((name) => {
        const column = columns(name);
        return column === undefined ? "" : stringAt(strings, values[column]);
      });
      if (paintOrders) {
        const paint = number(paintOrders[l]);
        if (paint === undefined) delete node.paint;
        else node.paint = paint;
      }
      const scrolled = fourNumbers(scrollRects[l]);
      const client = fourNumbers(clientRects[l]);
      if (client) node.clientRect = { x: rect.x + client[0], y: rect.y + client[1], w: client[2], h: client[3] };
      if (scrolled && client) {
        node.scrollBox = { scrollTop: scrolled[1], scrollHeight: scrolled[3], clientHeight: client[3] };
      }
    }
  });
  const first = start[0] ?? out.length;
  for (let i = first; i < out.length; i += 1) {
    const parent = out[out[i]!.parent];
    if (parent) parent.children.push(i);
  }
  for (const { host, shown } of hosts) {
    const root = Number.isInteger(shown) && shown >= 0 ? start[shown] : undefined;
    const shownRoot = root === undefined ? undefined : out[root];
    if (root === undefined || !shownRoot) continue;
    shownRoot.parent = host;
    out[host]?.children.push(root);
  }
  return first;
}

/** A list of four numbers (a rect as the snapshot writes it), a part that is no number as 0. */
function fourNumbers(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  return [number(value[0]) ?? 0, number(value[1]) ?? 0, number(value[2]) ?? 0, number(value[3]) ?? 0];
}

/**
 * Where document `d` of a frame sits: the frame's own offset for its first, the box of the `<iframe>` that shows
 * it for another (remembered once found).
 */
function offsetOf(
  d: number,
  known: Map<number, Offset>,
  hosts: readonly { host: number; shown: number }[],
  out: readonly DomNode[],
  offset: Offset,
): Offset {
  const found = known.get(d);
  if (found) return found;
  for (const { host, shown } of hosts) {
    if (shown !== d) continue;
    const rect = out[host]?.clientRect ?? out[host]?.rect;
    const at = rect ? { x: rect.x, y: rect.y } : offset;
    known.set(d, at);
    return at;
  }
  return offset;
}

/** Reads the accessibility trees of one frame target's documents onto its nodes, from `first` on. */
function readAccessibility(trees: readonly unknown[][], nodes: DomNode[], first: number): void {
  const byBackend = new Map<number, number>();
  for (let i = first; i < nodes.length; i += 1) byBackend.set(nodes[i]!.backendNodeId, i);
  for (const tree of trees) {
    for (const ax of tree) {
      const id = integer(member(ax, "backendDOMNodeId"));
      const target = id === undefined ? undefined : byBackend.get(id);
      if (target === undefined) continue;
      const props = new Map<string, unknown>();
      for (const property of items(member(ax, "properties"))) {
        const name = has(property, "name") ? String(member(property, "name")) : "undefined";
        const held = member(property, "value");
        if (has(held, "value")) props.set(name, member(held, "value"));
        else props.delete(name);
      }
      const name = member(member(ax, "name"), "value") ?? undefined;
      const valueHolder = member(ax, "value");
      const role = member(member(ax, "role"), "value") ?? undefined;
      const ignored = Boolean(member(ax, "ignored"));
      const reasons = items(member(ax, "ignoredReasons")).map((reason) => string(member(reason, "name")));
      nodes[target]!.ax = {
        role: role === undefined ? "" : String(role),
        name: (name === undefined ? "" : String(name)).trim(),
        value: has(valueHolder, "value") ? String(member(valueHolder, "value")) : undefined,
        props,
        hidden: ignored && reasons.some((reason) => reason !== undefined && HIDDEN_REASONS.includes(reason)),
        behindModal: ignored && reasons.includes(BEHIND_MODAL_REASON),
      };
    }
  }
  // What the tree leaves out under a node behind a modal dialog is behind it too; the dialog, which the tree has,
  // is not. A parent comes before its children, a frame's owner before the frame.
  for (let i = first; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    node.behindModal = node.ax ? node.ax.behindModal : (nodes[node.parent]?.behindModal ?? false);
  }
}

/** Browser-supplied DOM, layout and accessibility facts of a capture, every frame in one list. */
export interface CapturedDom {
  nodes: DomNode[];
  url: string;
  title: string;
}

/** The capture's nodes, its top document's address and title. */
export function capturedDom(capture: PageCapture): CapturedDom {
  const nodes: DomNode[] = [];
  let url = "";
  let title = "";
  const columns: StyleColumns = (name) => styleAt(capture, name);
  for (const frame of capture.frames) {
    const first = nodes.length;
    const root = readSnapshot(frame.snapshot, nodes, frame, columns);
    if (frame.top) {
      const doc = frame.snapshot.documents[0];
      url = stringAt(frame.snapshot.strings, member(doc, "documentURL"));
      title = stringAt(frame.snapshot.strings, member(doc, "title"));
    } else if (frame.owner) {
      const owner = frame.owner;
      const found = nodes.findIndex(
        (node, index) => index < first && node.backendNodeId === owner.backendNodeId && node.session === owner.session,
      );
      if (found >= 0 && root < nodes.length) {
        nodes[root]!.parent = found;
        nodes[found]!.children.push(root);
      }
    }
    readAccessibility(frame.accessibility, nodes, first);
  }
  return { nodes, url, title };
}

/**
 * CSS-generated text (`::before`, `::after`) has accessibility StaticText children but no DOM text node of its own:
 * it becomes the pseudo element's text.
 */
export function readGeneratedContent(capture: PageCapture, nodes: DomNode[]): void {
  const pseudo = new Map<string, number>();
  const key = (session: string, backendNodeId: number) => `${backendNodeId} ${session}`;
  for (const node of nodes) {
    if (PSEUDO_TAGS.includes(node.tag)) pseudo.set(key(node.session, node.backendNodeId), node.index);
  }
  if (pseudo.size === 0) return;
  for (const frame of capture.frames) {
    for (const tree of frame.accessibility) {
      const byId = new Map<string, unknown>();
      for (const ax of tree) {
        const id = string(member(ax, "nodeId"));
        if (id !== undefined) byId.set(id, ax);
      }
      for (const ax of tree) {
        const backend = member(ax, "backendDOMNodeId");
        const index = Number.isInteger(backend) ? pseudo.get(key(frame.session, backend as number)) : undefined;
        if (index === undefined) continue;
        const stack = [...items(member(ax, "childIds"))].reverse();
        const found: string[] = [];
        const seen = new Set<string>();
        while (stack.length > 0) {
          const id = stack.pop();
          if (typeof id !== "string" || seen.has(id)) continue;
          seen.add(id);
          const child = byId.get(id);
          if (child === undefined || has(child, "backendDOMNodeId")) continue;
          if (member(member(child, "role"), "value") === STATIC_TEXT_ROLE) {
            const text = string(member(member(child, "name"), "value"));
            if (text !== undefined) found.push(text);
          } else {
            stack.push(...[...items(member(child, "childIds"))].reverse());
          }
        }
        if (found.length > 0) {
          nodes[index]!.nodeType = TEXT_NODE;
          nodes[index]!.text = found.join(" ");
        }
      }
    }
  }
}
