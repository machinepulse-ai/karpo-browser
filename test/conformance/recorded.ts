/** What a recorded capture tells besides the page: the boxes a secret was typed into, and the recorded ids. */

import type { PageCapture } from "../../src/contracts/capture.ts";
import { integer, items, member } from "../../src/json.ts";
import type { PageTree } from "../../src/reading/tree.ts";
import { secretKey } from "../../src/reading/tree.ts";

/** The mark the recording platform drew on a box it typed a secret into: dots, set important on the element. */
const TYPED_MARK = "-webkit-text-security: disc !important";

/** The boxes a secret was typed into, as a recorded capture shows them. */
export function typedBoxes(capture: PageCapture): Set<string> {
  const boxes = new Set<string>();
  for (const frame of capture.frames) {
    const strings = frame.snapshot.strings;
    const text = (index: unknown) => (integer(index) === undefined ? undefined : strings[integer(index)!]);
    for (const document of frame.snapshot.documents) {
      const nodes = member(document, "nodes");
      const attributes = items(member(nodes, "attributes"));
      items(member(nodes, "backendNodeId")).forEach((id, at) => {
        const pairs = items(attributes[at]);
        for (let a = 0; a + 1 < pairs.length; a += 2) {
          if (text(pairs[a]) === "style" && text(pairs[a + 1])?.includes(TYPED_MARK) && Number.isInteger(id)) {
            boxes.add(secretKey(frame.target ?? "", id as number));
          }
        }
      });
    }
  }
  return boxes;
}

/** Each element's recorded id (`<frame index>.<backend node id>`) and its number in the reading. */
export function recordedIds(capture: PageCapture, tree: PageTree): Record<string, number> {
  const frames = new Map(capture.frames.map((frame, index) => [frame.session, index]));
  const ids: Record<string, number> = {};
  for (const element of tree.elements) {
    const frame = frames.get(element.binding.session);
    if (frame !== undefined) ids[`${frame}.${element.binding.backendNodeId}`] = element.number;
  }
  return ids;
}
