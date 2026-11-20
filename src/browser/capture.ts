/**
 * The page as the browser renders it, read in one pass per frame: Chrome's DOM snapshot with the computed styles the
 * reading reads, and its accessibility trees. What a reader reads, and what a replay feeds one.
 */

import type { FrameCapture, PageCapture, RawSnapshot } from "../contracts/capture.ts";
import { SNAPSHOT_STYLES } from "../contracts/capture.ts";
import { items, member, number } from "../json.ts";
import type { Tab, TabFrame } from "./tab.ts";

/** The frame ids of a frame tree, the frame first, then its children's, depth first; false where it is no tree. */
function walk(tree: unknown, frameIds: unknown[]): boolean {
  const frame = member(tree, "frame");
  if (frame === undefined) return false;
  frameIds.push(member(frame, "id"));
  const children = member(tree, "childFrames");
  if (children === undefined || children === null) return true;
  return Array.isArray(children) && children.every((child) => walk(child, frameIds));
}

/** The accessibility trees of one frame target's documents, as the browser gave them. */
async function captureAccessibility(tab: Tab, session: string): Promise<unknown[][]> {
  const frameIds: unknown[] = [];
  const tree = await tab.send("Page.getFrameTree", {}, session).catch(() => undefined);
  if (!walk(member(tree, "frameTree"), frameIds)) frameIds.push("");
  // Asked together: the browser answers each frame's tree on its own, in the order asked.
  return Promise.all(
    frameIds.map(async (frameId) => {
      const answer = await tab
        .send("Accessibility.getFullAXTree", frameId ? { frameId } : {}, session)
        .catch(() => undefined);
      return [...items(member(answer, "nodes"))];
    }),
  );
}

/**
 * One frame of the tab as the browser gave it; undefined for an out-of-process frame that cannot be read. Its parts
 * are asked for together: each is a round trip to a browser that may be remote.
 */
async function captureFrame(tab: Tab, frame: TabFrame): Promise<FrameCapture | undefined> {
  const session = frame.sessionId ?? tab.sessionId;
  const parentSession = frame.parentSessionId ?? tab.sessionId;
  const child = frame.sessionId !== undefined;
  const params = { computedStyles: SNAPSHOT_STYLES, includeDOMRects: true, includePaintOrder: true };
  const snapshot = tab.send("DOMSnapshot.captureSnapshot", params, session).catch((error) => {
    // The page's own document must be read; a frame that went away while it was read is left out.
    if (!child) throw error;
    return undefined;
  });
  // An out-of-process frame's document hangs under its <iframe> in the parent's document.
  const owner = child
    ? tab.send("DOM.getFrameOwner", { frameId: frame.targetId }, parentSession).catch(() => undefined)
    : undefined;
  const offset = child ? tab.frameOffset(frame).catch(() => undefined) : { x: 0, y: 0 };
  const [read, hosting, accessibility, at] = await Promise.all([
    snapshot,
    owner,
    captureAccessibility(tab, session),
    offset,
  ]);
  if (!at || !read) return undefined;
  const backendNodeId = number(member(hosting, "backendNodeId"));
  return {
    session,
    target: frame.targetId,
    top: !child,
    offset: at,
    ...(backendNodeId === undefined ? {} : { owner: { session: parentSession, backendNodeId } }),
    snapshot: read as RawSnapshot,
    accessibility,
  };
}

/** Reads the whole tab: the page and every out-of-process frame, laid out in the page's viewport. */
export async function captureTab(tab: Tab): Promise<PageCapture> {
  const began = Date.now();
  try {
    return await captureFrames(tab);
  } finally {
    tab.noteCapture(Date.now() - began);
  }
}

async function captureFrames(tab: Tab): Promise<PageCapture> {
  // Every frame is read at once; they keep the order the tab lists them in, the page first.
  const [metrics, read] = await Promise.all([
    tab.send("Page.getLayoutMetrics"),
    Promise.all(tab.frames().map((frame) => captureFrame(tab, frame))),
  ]);
  const view = member(metrics, "cssVisualViewport") ?? member(metrics, "visualViewport");
  const content = member(metrics, "cssContentSize") ?? member(metrics, "contentSize");
  if (!view || !content) throw new Error("the page gives no viewport");
  const frames = read.filter((frame) => frame !== undefined);
  const viewport = {
    w: Math.round(Number(member(view, "clientWidth"))),
    h: Math.round(Number(member(view, "clientHeight"))),
  };
  return {
    viewport,
    scroll: {
      top: Math.round(number(member(view, "pageY")) ?? 0),
      maxTop: Math.max(0, Math.round(Number(member(content, "height")) - viewport.h)),
    },
    frames,
    unreadFrames: read.length - frames.length,
    styles: [...SNAPSHOT_STYLES],
  };
}
