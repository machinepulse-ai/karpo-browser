/**
 * The page as the browser gave it, before any reading: what a reader reads and what a replay feeds a reader again.
 * The browser's own payloads (DOM snapshots, accessibility nodes) are kept as the JSON they came in.
 */

/**
 * The computed styles the reading reads: whether a box is drawn, whether it shows the hand that says it takes a
 * click, what clips it (its overflow, and how it is placed), and whether it hides what is drawn under it (its
 * background and opacity, whether it takes the pointer there at all, and whether a clip shape cuts it).
 */
export const SNAPSHOT_STYLES = [
  "display",
  "visibility",
  "cursor",
  "overflow-x",
  "overflow-y",
  "position",
  "background-color",
  "opacity",
  "pointer-events",
  "clip-path",
] as const;

export type StyleName = (typeof SNAPSHOT_STYLES)[number];

/** A point in the page's viewport. */
export interface Offset {
  x: number;
  y: number;
}

/** A node by the CDP session whose document holds it and its backend id. */
export interface SessionNode {
  session: string;
  backendNodeId: number;
}

/** `DOMSnapshot.captureSnapshot`'s answer, untouched: its documents and its string table. */
export interface RawSnapshot {
  documents: unknown[];
  strings: string[];
}

/** One frame target as captured: its document snapshot and accessibility trees, untouched. */
export interface FrameCapture {
  /** The CDP session the frame is read through; the top document's is the tab's own. */
  session: string;
  /** The CDP target the frame belongs to: the page, or an out-of-process frame. */
  target?: string;
  /** The top document (not an out-of-process frame). */
  top: boolean;
  /** Where the frame sits in the page's viewport. */
  offset: Offset;
  /** For an out-of-process frame: the `<iframe>` element that hosts it, in its parent's document. */
  owner?: SessionNode;
  snapshot: RawSnapshot;
  /** `Accessibility.getFullAXTree`'s nodes, one list per frame of the target, as the browser gave them. */
  accessibility: unknown[][];
}

/** The page as the browser gave it. It holds what boxes contain as typed. */
export interface PageCapture {
  /** The viewport in CSS pixels. */
  viewport: { w: number; h: number };
  /** How far the top document is scrolled, and how far it can be. */
  scroll: Scroll;
  frames: FrameCapture[];
  /** Out-of-process frames whose document could not be read. */
  unreadFrames: number;
  /** The computed styles each layout node lists, in their order; left out, they are `SNAPSHOT_STYLES`. */
  styles?: string[];
}

export interface Scroll {
  top: number;
  maxTop: number;
}

/** The position of a computed style in each layout node's list; undefined when the capture did not take it. */
export function styleAt(capture: PageCapture, name: StyleName): number | undefined {
  const styles: readonly string[] = capture.styles?.length ? capture.styles : SNAPSHOT_STYLES;
  const at = styles.indexOf(name);
  return at < 0 ? undefined : at;
}

/** What a masked text is written with, one for each character it had: the dots a secret box shows. */
const MASK = "•";
/**
 * A secret shorter than this is masked only where a text is exactly it: a few characters occur in any page, and
 * masking them within other texts would blot the page.
 */
const MASK_WITHIN_FROM = 6;

function dots(text: string): string {
  return MASK.repeat([...text].length);
}

/** A text with what it holds of the secrets written as dots; the same text when it holds none. */
function masked(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out === secret) return dots(secret);
    if (secret.length >= MASK_WITHIN_FROM && out.includes(secret)) out = out.replaceAll(secret, dots(secret));
  }
  return out;
}

/** Masks every string of a JSON value in place. */
function maskStrings(value: unknown, secrets: readonly string[]): void {
  if (typeof value !== "object" || value === null) return;
  const holder = value as Record<string, unknown>;
  for (const key of Object.keys(holder)) {
    const held = holder[key];
    if (typeof held === "string") holder[key] = masked(held, secrets);
    else maskStrings(held, secrets);
  }
}

/**
 * Writes as dots, in place, what the capture holds of secrets typed into the page: a box masked by its node is one
 * thing, but a page may show what was typed elsewhere (a card's preview, a summary) or draw its box anew.
 */
export function maskTexts(capture: PageCapture, secrets: readonly string[]): void {
  const typed = secrets.filter((secret) => secret !== "");
  if (typed.length === 0) return;
  for (const frame of capture.frames) {
    frame.snapshot.strings = frame.snapshot.strings.map((text) => masked(text, typed));
    maskStrings(frame.accessibility, typed);
  }
}
