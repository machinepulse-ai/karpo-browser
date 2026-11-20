import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const SUMMARY = fileURLToPath(new URL("./summary.ts", import.meta.url));
const RUN = "agent_hardbenchmark__karpo-browser_controller__20261120-193249-dbc1faf4854b6554";
/** The exit code of a directory that holds no judged task. */
const EMPTY_EXIT = 1;

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A task's row as the harness writes it: its verdict, and its log with the agent's time when given. */
function row(task: string, verdict: object, log?: { name: string; seconds: number }): void {
  const scores = path.join(root!, RUN, task, "2026-11-20T16-33-10-281Z", "scores");
  fs.mkdirSync(scores, { recursive: true });
  fs.writeFileSync(path.join(scores, "result.json"), JSON.stringify(verdict));
  if (!log) return;
  const logs = path.join(root!, RUN, "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, log.name),
    `2026-11-20T16:40:00.000Z [trace] timing · agent=${log.seconds.toFixed(1)}s · evidence=3.0s · verifier=30.0s\n`,
  );
}

function summary(dir: string) {
  return spawnSync(process.execPath, [SUMMARY, dir], { encoding: "utf8" });
}

it("gives each task's verdict, process score and agent time, and the run's totals", () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-"));
  row(
    "06189d67b34ea559",
    { outcomeSuccess: true, processScore: 1 },
    { name: "06189d67-ocw.mit.edu__karpo-browser-controller.log", seconds: 100 },
  );
  row(
    "rockauto_1225",
    { outcomeSuccess: false, processScore: 0.5 },
    { name: "rockauto_1225__karpo-browser-controller.log", seconds: 200 },
  );
  row("48e2ec53f672cc30", { graded: false, verifierError: "the judge did not answer" });
  const printed = summary(root);
  expect(printed.status).toBe(0);
  expect(printed.stdout).toMatch(/^06189d67b34ea559 +passed +1\.00 +100\.0 s$/m);
  expect(printed.stdout).toMatch(/^rockauto_1225 +failed +0\.50 +200\.0 s$/m);
  expect(printed.stdout).toMatch(/^48e2ec53f672cc30 +not graded +- +-$/m);
  expect(printed.stdout).toContain("passed: 1 of 2 graded (50%), 3 tasks");
  expect(printed.stdout).toContain("process score: 0.75 on average");
  expect(printed.stdout).toContain("agent time: 150.0 s on average, 150.0 s median (2 tasks)");
});

it("says so when the directory holds no judged task", () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-"));
  const printed = summary(root);
  expect(printed.status).toBe(EMPTY_EXIT);
  expect(printed.stderr).toMatch(/no scores\/result\.json under/);
});
