/**
 * Conformance fixtures: recorded calls as the reference reader was given them and what it answered. They hold what
 * recorded pages showed, so they stay outside the repository; `CONFORMANCE_FIXTURES` names their directory.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { PageCapture } from "../../src/contracts/capture.ts";

/** A recorded step as the reference reader is given it. */
export interface StepInput {
  capture: PageCapture | null;
  seconds?: number;
  image_tokens?: number;
  solve_captcha?: boolean;
  back?: boolean;
  withheld?: string[];
  finalists?: string[] | null;
  finals_seconds?: number | null;
  taken?: TakenInput | null;
}

/** What a recorded step did. */
export interface TakenInput {
  operation: string;
  target?: number | string | null;
  argument?: string | null;
  note?: string | null;
  done?: boolean;
}

/** What the reference reader answered for one step. */
export interface StepOutput {
  index: number;
  state: string;
  request?: unknown;
  options?: unknown;
  tokens?: number;
  cut?: boolean;
  groups: { request: unknown }[];
  boxes: Record<string, number[]>;
  viewport: { w: number; h: number };
  ids: Record<string, number>;
}

export interface Fixture {
  name: string;
  meta: { run: string; call: string; pages: { page: number; step: number; replay: string }[] };
  input: {
    request: {
      models: unknown[];
      plugins: { module: { settings: Record<string, unknown>; texts: Record<string, string> } }[];
    };
    goal: string;
    values: { n: number; name: string; text: string | null }[] | null;
    steps: StepInput[];
  };
  output: { steps: StepOutput[]; unread: number[] };
}

/** What ends the name of a run's recorded follow-ups. */
const FOLLOW_UPS_SUFFIX = ".followups.json.gz";

/** A recorded follow-up: the step it followed (its call and index there), the option that step chose, its request. */
export interface FollowUp {
  call: number;
  step: number;
  key: string | null;
  request: { state: unknown; questions: Record<string, { criteria: Record<string, string> }> };
}

function readGzipped(path: string): unknown {
  return JSON.parse(gunzipSync(readFileSync(path)).toString());
}

/** The fixtures of a directory, one at a time (each holds whole page captures). */
export function* fixtures(directory: string, limit = Number.POSITIVE_INFINITY): Generator<Fixture> {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".json.gz") && !name.endsWith(FOLLOW_UPS_SUFFIX))
    .filter((name) => name.includes(process.env.ONLY ?? ""))
    .sort();
  for (const name of names.slice(0, limit)) {
    yield { name, ...(readGzipped(join(directory, name)) as Omit<Fixture, "name">) };
  }
}

/** The recorded follow-ups of a fixture's call; none when the run's were not exported. */
export function followUps(directory: string, fixture: Fixture): FollowUp[] {
  const [run, call] = fixture.name.split(".");
  const path = join(directory, run + FOLLOW_UPS_SUFFIX);
  if (!existsSync(path)) return [];
  return (readGzipped(path) as FollowUp[]).filter((followUp) => followUp.call === Number(call));
}

/** The directory the fixtures are in. */
export function fixturesDirectory(): string {
  const directory = process.env.CONFORMANCE_FIXTURES;
  if (!directory) throw new Error("CONFORMANCE_FIXTURES names no fixtures directory");
  return directory;
}
