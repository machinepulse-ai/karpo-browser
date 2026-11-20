/** The page as one step reads it: the tree the decision model reads, and the state the page is in. */

import type { PageCapture } from "../contracts/capture.ts";
import { stateOf, steadyStateOf } from "../reading/state.ts";
import type { PageTree, ReadOptions } from "../reading/tree.ts";
import { readPage } from "../reading/tree.ts";

export interface Reading {
  tree: PageTree;
  /** The page's state: two readings have the same one when the page holds the same things, wherever it is scrolled. */
  state: string;
  /**
   * Its state, what changes on the page by itself left out (`steadyStateOf`): what the run's check for going in circles
   * compares. The page's state when nothing on it is marked so.
   */
  steady: string;
}

/** Reads a capture. */
export function read(capture: PageCapture, options: ReadOptions): Reading {
  const tree = readPage(capture, options);
  const state = stateOf(tree);
  return { tree, state, steady: tree.changing.size === 0 ? state : steadyStateOf(tree) };
}
