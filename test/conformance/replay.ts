/**
 * Replays recorded calls the way the reference reader does and checks every request against its answer: each recorded
 * page is read again, what the recorded step did goes into the run's history, and the step's request is packed with
 * the release's settings and texts. The requests must come out the same, character for character.
 *
 * usage: CONFORMANCE_FIXTURES=<dir> node test/conformance/replay.ts [files] [first file]
 */

import * as actions from "../../src/contracts/actions.ts";
import type { PageCapture } from "../../src/contracts/capture.ts";
import { Texts } from "../../src/contracts/texts.ts";
import type { Packed, PackInput } from "../../src/decider/pack.ts";
import { pack, packFinalists } from "../../src/decider/pack.ts";
import type { TaskValue } from "../../src/decider/request.ts";
import { elementContext, optionQuestion, request, VALUE, valueQuestion } from "../../src/decider/request.ts";
import type { DecisionRequest } from "../../src/decider/systemone.ts";
import { DEFAULT_CHARS_PER_TOKEN, estimate } from "../../src/decider/tokens.ts";
import type { ReadingSettings } from "../../src/reading/tree.ts";
import { pageScrolls } from "../../src/reading/tree.ts";
import type { Taken } from "../../src/run/history.ts";
import { History, takenOn, takenOnPage } from "../../src/run/history.ts";
import type { Reading } from "../../src/run/page.ts";
import { read } from "../../src/run/page.ts";
import type { Fixture, FollowUp, StepOutput, TakenInput } from "./fixtures.ts";
import { fixtures, fixturesDirectory, followUps } from "./fixtures.ts";
import { recordedIds, typedBoxes } from "./recorded.ts";

/** The operations a recorded step may name, as the history keeps them. */
const OPERATIONS: readonly string[] = [
  actions.CLICK,
  actions.FILL,
  actions.SELECT,
  actions.PRESS_ENTER,
  actions.SCROLL_DOWN,
  actions.SCROLL_UP,
  actions.DONE,
  ...actions.PAGE_STEPS,
];

/** A model of the release's catalogue, as far as packing reads it. */
interface CatalogueModel {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  maxChoices?: number;
  tokenCounter?: { charsPerToken?: number };
}

interface Settings {
  reading: ReadingSettings;
  decider: { model: string }[];
}

/** A step read: its page, the capture it was read from, and what the step then did. */
interface ReadStep {
  reading: Reading;
  capture: PageCapture;
  taken: TakenInput | null | undefined;
}

/** What a recorded step did, as the history takes it: on its element when the reading has it, else on the page. */
function takenOf(step: ReadStep): Taken | undefined {
  const recorded = step.taken;
  if (!recorded || !OPERATIONS.includes(recorded.operation)) return undefined;
  const tree = step.reading.tree;
  const number =
    typeof recorded.target === "string"
      ? recordedIds(step.capture, tree)[recorded.target]
      : (recorded.target ?? undefined);
  const element = number === undefined ? undefined : tree.elements.find((candidate) => candidate.number === number);
  const taken = element ? takenOn(recorded.operation, element) : takenOnPage(recorded.operation);
  taken.argument = recorded.argument ?? undefined;
  taken.done = recorded.done ?? true;
  taken.note = taken.done ? (recorded.note ?? undefined) : (recorded.note ?? "");
  return taken;
}

/** A packed request as the reference reader's answer gives it. */
function round(packed: Packed): { request: DecisionRequest; options: string[]; tokens: number; cut: boolean } {
  return { request: packed.request, options: packed.options, tokens: packed.tokens, cut: packed.cut };
}

/** One step replayed: what the reference reader's answer holds of it, and the page it was packed from. */
interface Replayed {
  index: number;
  state: string;
  main: ReturnType<typeof round> | undefined;
  groups: ReturnType<typeof round>[];
  input: PackInput;
}

function* replay(fixture: Fixture): Generator<Replayed> {
  const module = fixture.input.request.plugins[0]!.module;
  const settings = module.settings as unknown as Settings;
  const texts = new Texts(module.texts);
  const catalogue = fixture.input.request.models as CatalogueModel[];
  const chain = settings.decider.map((link) => catalogue.find((model) => model.id === link.model)!);
  const budget = Math.min(...chain.map((model) => Math.max(model.contextWindow - model.maxOutputTokens, 0)));
  const limits = chain.map((model) => model.maxChoices ?? 0).filter((most) => most > 0);
  const maxChoices = limits.length > 0 ? Math.min(...limits) : 0;
  const counter = estimate(chain[0]!.tokenCounter?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const values: TaskValue[] = (fixture.input.values ?? []).map((value) => ({
    ...value,
    text: value.text ?? undefined,
  }));
  const reading = settings.reading;
  const history = new History();
  let previous: ReadStep | undefined;
  for (const [index, step] of fixture.input.steps.entries()) {
    const capture = step.capture;
    if (!capture) {
      previous = undefined;
      continue;
    }
    const now = read(capture, { reading, secrets: typedBoxes(capture) });
    const taken = previous ? takenOf(previous) : undefined;
    if (previous && taken) history.took(taken, previous.reading, now, texts);
    history.read(now);
    const tree = now.tree;
    const seconds = step.seconds ?? 0;
    const scrolls = pageScrolls(tree);
    const input: PackInput = {
      tree,
      marks: reading.triedMarks ? history.marks(now, texts) : new Map(),
      reading,
      texts,
      parts: {
        goal: fixture.input.goal,
        values,
        run: reading.runSummary ? history.summary(now, seconds) : undefined,
        url: tree.url,
        title: tree.title,
      },
      actions: history.recent(tree, Math.max(reading.recentActionsMax, 0), texts),
      steps: {
        scrollDown: scrolls.down,
        scrollUp: scrolls.up,
        solveCaptcha: step.solve_captcha ?? true,
        back: step.back ?? false,
      },
      withheld: new Set(step.withheld ?? []),
      budget: Math.max(budget - (step.image_tokens ?? 0), 0),
      maxChoices,
      counter,
    };
    const packing = pack(input);
    if (packing.kind === "one") {
      yield { index, state: now.state, main: round(packing.packed), groups: [], input };
    } else {
      const run = reading.runSummary ? history.summary(now, step.finals_seconds ?? seconds) : undefined;
      const finals = step.finalists
        ? packFinalists({ ...input, parts: { ...input.parts, run } }, step.finalists, packing.groups.length)
        : undefined;
      yield { index, state: now.state, main: finals && round(finals), groups: packing.groups.map(round), input };
    }
    history.decisions += 1;
    previous = { reading: now, capture, taken: step.taken };
  }
}

/** How much of two differing texts is shown on each side of where they first differ. */
const DIFFERENCE_CONTEXT = 70;

/** Where two JSON values first differ, as a path. */
function firstDifference(a: unknown, b: unknown, path = ""): string | undefined {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (typeof a === "string" && typeof b === "string") {
    let at = 0;
    while (at < a.length && a[at] === b[at]) at += 1;
    const around = (text: string) =>
      JSON.stringify(text.slice(Math.max(at - DIFFERENCE_CONTEXT, 0), at + DIFFERENCE_CONTEXT));
    return `${path} at ${at}: ${around(a)} ≠ ${around(b)}`;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${path}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`;
  }
  const [keysA, keysB] = [Object.keys(a), Object.keys(b)];
  if (keysA.join("\u0000") !== keysB.join("\u0000")) {
    const at = keysA.findIndex((key, i) => key !== keysB[i]);
    return `${path} keys at ${at}: ${keysA[at]} ≠ ${keysB[at]} (${keysA.length} and ${keysB.length} keys)`;
  }
  for (const key of keysA) {
    const found = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}/${key}`,
    );
    if (found) return found;
  }
  return `${path}: differs`;
}

/** What of a replayed step is not as the reference reader answered. */
function differences(ours: Replayed, expected: StepOutput): string[] {
  const found: string[] = [];
  if (ours.state !== expected.state) found.push("state");
  const theirs = [
    ...(expected.request === undefined ? [] : [{ name: "request", round: expected as ReturnType<typeof round> }]),
    ...expected.groups.map((group, n) => ({ name: `group ${n + 1}`, round: group as ReturnType<typeof round> })),
  ];
  const mine = [...(ours.main ? [ours.main] : []), ...ours.groups];
  if (mine.length !== theirs.length) return [...found, `requests (${mine.length}, expected ${theirs.length})`];
  theirs.forEach(({ name, round: want }, at) => {
    const got = mine[at]!;
    const difference = firstDifference(got.request, want.request, name);
    if (difference) found.push(difference);
    if (JSON.stringify(got.options) !== JSON.stringify(want.options)) found.push(`${name} options`);
    if (got.tokens !== want.tokens) found.push(`${name} tokens ${got.tokens} ≠ ${want.tokens}`);
    if (got.cut !== want.cut) found.push(`${name} cut`);
  });
  return found;
}

/**
 * A recorded follow-up asked again of a replayed step: the question about the element the step chose, with the
 * step's state. A dropdown asked in groups is asked the options its recorded request offered.
 */
function followUpDifference(ours: Replayed, recorded: FollowUp): string | undefined {
  const { tree, texts, parts } = ours.input;
  const number = actions.readKey(recorded.key ?? "").number;
  const element = tree.elements.find((candidate) => candidate.number === number);
  if (!element || !ours.main) return `no element ${recorded.key}`;
  const context = elementContext(tree, element, texts);
  const name = Object.keys(recorded.request.questions)[0]!;
  const offered = Object.keys(recorded.request.questions[name]!.criteria);
  const options = element.kind.kind === "select" ? element.kind.options : [];
  const question =
    name === VALUE
      ? valueQuestion(context, parts.values, texts)
      : optionQuestion(
          context,
          options.filter((option) => offered.includes(String(option.index))),
          0,
          texts,
        );
  const state = ours.main.request.state;
  return firstDifference(request(state, question), recorded.request, `follow-up ${name}`);
}

const limit = Number(process.argv[2] ?? Number.POSITIVE_INFINITY);
const totals = { calls: 0, pages: 0, same: 0, requests: 0, followUps: 0, sameFollowUps: 0, failed: 0 };
const failures: string[] = [];
for (const fixture of fixtures(fixturesDirectory(), limit)) {
  totals.calls += 1;
  const expected = new Map(fixture.output.steps.map((step) => [step.index, step]));
  const recorded = followUps(fixturesDirectory(), fixture);
  try {
    for (const ours of replay(fixture)) {
      const want = expected.get(ours.index)!;
      const found = differences(ours, want);
      totals.pages += 1;
      totals.requests += (ours.main ? 1 : 0) + ours.groups.length;
      if (found.length === 0) totals.same += 1;
      else failures.push(`${fixture.name} step ${ours.index}: ${found.join("; ")}`);
      for (const followUp of recorded.filter((each) => each.step === ours.index)) {
        const difference = followUpDifference(ours, followUp);
        totals.followUps += 1;
        if (!difference) totals.sameFollowUps += 1;
        else failures.push(`${fixture.name} step ${ours.index}: ${difference}`);
      }
    }
  } catch (error) {
    totals.failed += 1;
    failures.push(`${fixture.name}: ${error instanceof Error ? error.stack : error}`);
  }
}
console.log(JSON.stringify(totals));
for (const failure of failures.slice(0, Number(process.env.SHOW ?? 15))) console.log(failure.slice(0, 900));
process.exitCode = failures.length === 0 ? 0 : 1;
