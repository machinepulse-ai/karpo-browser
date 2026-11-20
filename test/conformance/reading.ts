/**
 * Checks the page reading alone against the reference reader: each recorded page's state, the number each recorded
 * node got and the box each numbered element shows.
 *
 * usage: CONFORMANCE_FIXTURES=<dir> node test/conformance/reading.ts [files]
 */

import type { PageCapture } from "../../src/contracts/capture.ts";
import { capturedDom } from "../../src/reading/dom.ts";
import { stateOf } from "../../src/reading/state.ts";
import type { PageTree, ReadingSettings } from "../../src/reading/tree.ts";
import { readPage } from "../../src/reading/tree.ts";
import { fixtures, fixturesDirectory } from "./fixtures.ts";
import { recordedIds, typedBoxes } from "./recorded.ts";

/** Each listed element's box in the viewport, by its number. */
function boxes(capture: PageCapture, tree: PageTree): Record<string, number[]> {
  const numbers = new Map(tree.elements.map((e) => [`${e.binding.backendNodeId} ${e.binding.session}`, e.number]));
  const { w, h } = capture.viewport;
  const out: Record<string, number[]> = {};
  for (const node of capturedDom(capture).nodes) {
    const number = numbers.get(`${node.backendNodeId} ${node.session}`);
    const rect = node.rect;
    if (number === undefined || !rect || rect.w <= 0 || rect.h <= 0) continue;
    if (rect.x >= w || rect.y >= h || rect.x + rect.w <= 0 || rect.y + rect.h <= 0) continue;
    out[String(number)] = [rect.x, rect.y, rect.w, rect.h];
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value) || typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const limit = Number(process.argv[2] ?? Number.POSITIVE_INFINITY);
const totals = { pages: 0, state: 0, ids: 0, boxes: 0 };
const failures: string[] = [];
for (const fixture of fixtures(fixturesDirectory(), limit)) {
  const reading = fixture.input.request.plugins[0]!.module.settings.reading as ReadingSettings;
  for (const expected of fixture.output.steps) {
    const capture = fixture.input.steps[expected.index]!.capture!;
    const tree = readPage(capture, { reading, secrets: typedBoxes(capture) });
    totals.pages += 1;
    const wrong = [
      stateOf(tree) === expected.state ? "" : "state",
      same(recordedIds(capture, tree), expected.ids) ? "" : "ids",
      same(boxes(capture, tree), expected.boxes) ? "" : "boxes",
    ].filter((part) => part !== "");
    for (const part of ["state", "ids", "boxes"] as const) if (!wrong.includes(part)) totals[part] += 1;
    if (wrong.length > 0) failures.push(`${fixture.name} step ${expected.index}: ${wrong.join(", ")}`);
  }
}
console.log(JSON.stringify(totals));
for (const failure of failures.slice(0, 20)) console.log(failure);
process.exitCode = failures.length === 0 ? 0 : 1;
