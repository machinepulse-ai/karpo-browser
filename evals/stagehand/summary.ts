/**
 * A run's results from the trajectories Stagehand's eval harness writes: each task's verdict, its process score and the
 * agent's own time, then the run's totals.
 *
 * node evals/stagehand/summary.ts <trajectories dir>
 *
 * The directory is the harness's EVAL_TRAJECTORY_ROOT, which holds a directory a run, or one run's directory. A task's
 * verdict is the judge's, in <run>/<task id>/<time>/scores/result.json. Its agent time (the agent alone: the harness's
 * evidence capture and the judging are not in it) is on the `timing · agent=…s` line the harness writes once the task
 * is judged, in the task's log: <run>/logs/<task's short id>-<site>__<model>.log.
 */
import fs from "node:fs";
import path from "node:path";

const RESULT_DIR = "scores";
const RESULT_FILE = "result.json";
const LOGS_DIR = "logs";
const LOG_SUFFIX = ".log";
/** The line of a task's log that gives the agent's time, in seconds. */
const AGENT_TIME = /timing · agent=(\d+(?:\.\d+)?)s/;
/**
 * What follows the task's short id in its log's name: its site or trial after "-", its model after "__", "~" a twin.
 */
const AFTER_SHORT_ID = /-|__|~/;
/** Ids of 16 or more hex digits go by their first 8 in the logs' names; other ids go whole. */
const HASH_ID = /^[0-9a-f]{16,}$/i;
const SHORT_ID_LENGTH = 8;
/** The table's columns after the task's: as wide as "not graded", "process" and "agent time". */
const VERDICT_WIDTH = 10;
const PROCESS_WIDTH = 7;
const TIME_WIDTH = 10;
/** The decimals a process score and a time are printed with. */
const PROCESS_DECIMALS = 2;
const TIME_DECIMALS = 1;
const PERCENT = 100;
const USAGE = "usage: node evals/stagehand/summary.ts <trajectories dir>";
/** The exit codes: no task found, and a call that cannot be worked as given. */
const EMPTY_EXIT = 1;
const USAGE_EXIT = 2;

/** One task of a run, as the judge and the harness's log have it. */
interface Row {
  task: string;
  /** Whether the judge passed it; none when it was not graded. */
  passed: boolean | undefined;
  process: number | undefined;
  seconds: number | undefined;
}

/** What the judge's result says, of what is read here. */
interface Verdict {
  graded?: boolean;
  outcomeSuccess?: unknown;
  processScore?: unknown;
}

/** The id a task's log is named by. */
function shortId(task: string): string {
  return HASH_ID.test(task) ? task.slice(0, SHORT_ID_LENGTH) : task;
}

/** The agent time each task's log gives, by the task's short id: the last timing line of each log. */
function agentTimes(run: string): Map<string, number[]> {
  const times = new Map<string, number[]>();
  const logs = path.join(run, LOGS_DIR);
  if (!fs.existsSync(logs)) return times;
  for (const name of fs.readdirSync(logs)) {
    if (!name.endsWith(LOG_SUFFIX)) continue;
    const lines = fs.readFileSync(path.join(logs, name), "utf8").split("\n");
    const seconds = lines.findLast((line) => AGENT_TIME.test(line))?.match(AGENT_TIME)?.[1];
    if (seconds === undefined) continue;
    const id = name.split(AFTER_SHORT_ID)[0] ?? name;
    times.set(id, [...(times.get(id) ?? []), Number(seconds)]);
  }
  return times;
}

/** Each run's tasks, by the run's directory: every scores/result.json under the directory given. */
function runsUnder(root: string): Map<string, string[]> {
  const runs = new Map<string, string[]>();
  for (const found of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (path.basename(found) !== RESULT_FILE || path.basename(path.dirname(found)) !== RESULT_DIR) continue;
    // <run>/<task id>/<time>/scores/result.json
    const row = path.dirname(path.dirname(path.join(root, found)));
    const run = path.dirname(path.dirname(row));
    runs.set(run, [...(runs.get(run) ?? []), row]);
  }
  return runs;
}

/** A run's tasks: the judge's verdict of each, and its agent time when its log gives one alone. */
function rowsOf(run: string, rowDirs: readonly string[]): Row[] {
  const times = agentTimes(run);
  const tasks = rowDirs.map((row) => path.basename(path.dirname(row)));
  return rowDirs
    .map((row, at) => {
      const task = tasks[at] ?? "";
      const verdict = JSON.parse(fs.readFileSync(path.join(row, RESULT_DIR, RESULT_FILE), "utf8")) as Verdict;
      const graded = verdict.graded !== false && typeof verdict.outcomeSuccess === "boolean";
      const logged = times.get(shortId(task));
      // A task run more than once in the run (trials) has several rows and logs, which cannot be told apart here.
      const alone = logged?.length === 1 && tasks.filter((each) => each === task).length === 1;
      return {
        task,
        passed: graded ? verdict.outcomeSuccess === true : undefined,
        process: graded && typeof verdict.processScore === "number" ? verdict.processScore : undefined,
        seconds: alone ? logged[0] : undefined,
      };
    })
    .sort((a, b) => a.task.localeCompare(b.task));
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** A run's table and totals, as printed. */
function summary(run: string, rows: readonly Row[]): string {
  const width = Math.max("task".length, ...rows.map((row) => row.task.length));
  const verdictOf = (row: Row): string => (row.passed === undefined ? "not graded" : row.passed ? "passed" : "failed");
  const lines = [
    path.basename(run),
    `${"task".padEnd(width)}  ${"verdict".padEnd(VERDICT_WIDTH)}  ${"process".padStart(PROCESS_WIDTH)}  ` +
      `${"agent time".padStart(TIME_WIDTH)}`,
    ...rows.map(
      (row) =>
        `${row.task.padEnd(width)}  ${verdictOf(row).padEnd(VERDICT_WIDTH)}  ` +
        `${(row.process?.toFixed(PROCESS_DECIMALS) ?? "-").padStart(PROCESS_WIDTH)}  ` +
        `${(row.seconds === undefined ? "-" : `${row.seconds.toFixed(TIME_DECIMALS)} s`).padStart(TIME_WIDTH)}`,
    ),
  ];
  const graded = rows.filter((row) => row.passed !== undefined);
  const passed = graded.filter((row) => row.passed).length;
  const share = graded.length > 0 ? ` (${Math.round((passed / graded.length) * PERCENT)}%)` : "";
  lines.push(`passed: ${passed} of ${graded.length} graded${share}, ${rows.length} tasks`);
  const processes = rows.flatMap((row) => (row.process === undefined ? [] : [row.process]));
  if (processes.length > 0) lines.push(`process score: ${mean(processes).toFixed(PROCESS_DECIMALS)} on average`);
  const seconds = rows.flatMap((row) => (row.seconds === undefined ? [] : [row.seconds]));
  lines.push(
    seconds.length > 0
      ? `agent time: ${mean(seconds).toFixed(TIME_DECIMALS)} s on average, ` +
          `${median(seconds).toFixed(TIME_DECIMALS)} s median (${seconds.length} tasks)`
      : `agent time: no timing line found in ${path.join(path.basename(run), LOGS_DIR)}`,
  );
  return lines.join("\n");
}

function main(): number {
  const root = process.argv[2];
  if (!root || process.argv.length > 3) {
    console.error(USAGE);
    return USAGE_EXIT;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`${root} is not a directory\n${USAGE}`);
    return USAGE_EXIT;
  }
  const runs = runsUnder(root);
  if (runs.size === 0) {
    console.error(
      `no ${path.join(RESULT_DIR, RESULT_FILE)} under ${root}: the harness writes one for each task it judged`,
    );
    return EMPTY_EXIT;
  }
  const printed = [...runs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([run, rowDirs]) => summary(run, rowsOf(run, rowDirs)));
  console.log(printed.join("\n\n"));
  return 0;
}

process.exitCode = main();
