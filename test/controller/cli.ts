/**
 * The controller on the command line: one task worked from a start page, with a general model as System 2 and the
 * decision model as System 1; prints the answer.
 *
 * node test/controller/cli.ts --url https://books.toscrape.com/ "Find the price of the book A Light in the Attic"
 */

import { parseArgs } from "node:util";
import { Browser, system1Of } from "../../src/index.ts";
import { BENCHMARK_MODEL, benchmarkBrowserOptions, benchmarkControlOptions } from "./benchmark.ts";
import { controllerBrowser } from "./browser.ts";
import { control } from "./controller.ts";
import { CONTROLLER_MODELS, controllerModel } from "./models.ts";

const MODEL_VARIABLE = "SYSTEM2_MODEL";
const BASE_URL_VARIABLE = "SYSTEM2_BASE_URL";
const API_KEY_VARIABLE = "SYSTEM2_API_KEY";
/** The addresses of a server on this machine, which may answer without a key. */
const LOCAL_ADDRESSES = ["http://127.0.0.1", "http://localhost"];
/** The exit codes: answered, ended without an answer, could not be worked as given. */
const ANSWERED_EXIT = 0;
const UNANSWERED_EXIT = 1;
const USAGE_EXIT = 2;
/** The exit code of a process a signal ended. */
const SIGNAL_EXIT = 130;

const USAGE = `usage: node test/controller/cli.ts [--url <address>] [options] <the task, in words>

Works the task with the controller: a general model (System 2) plans, hands goals to the decision model (System 1),
reads the pages and answers.

  --url <address>        the page to start on
  --cdp <ws address>     work a browser that runs already instead of starting Chrome
  --headless             start Chrome without a window
  --json                 print the whole result as JSON
  --benchmark            the configuration of our published runs: DeepSeek V4.1 Flash on OpenRouter (the provider
                         left to OpenRouter's routing), a 450 s deadline and the options in
                         test/controller/benchmark.ts; a model SYSTEM2_MODEL names is used in place of that one

System 2 is the model SYSTEM2_MODEL names (a preset: ${Object.keys(CONTROLLER_MODELS).join(", ")}; or any model id)
at SYSTEM2_BASE_URL (default: OpenRouter's) with the key in SYSTEM2_API_KEY. System 1 is set by SYSTEM1_URL,
SYSTEM1_MODEL and SYSTEM1_API_KEY, as for karpo-browser itself.`;

async function main(): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      cdp: { type: "string" },
      headless: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      benchmark: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (flags.help) {
    console.log(USAGE);
    return ANSWERED_EXIT;
  }
  const task = positionals.join(" ").trim();
  if (!task) {
    console.error(USAGE);
    return USAGE_EXIT;
  }
  const name = process.env[MODEL_VARIABLE]?.trim();
  if (!name && !flags.benchmark) {
    console.error(`no System 2 model: set ${MODEL_VARIABLE} to one of ${Object.keys(CONTROLLER_MODELS).join(", ")}`);
    console.error("or to any model id at SYSTEM2_BASE_URL");
    return USAGE_EXIT;
  }
  // System 1's settings (it throws, naming the variable, when they are missing) and System 2's key are checked before
  // a browser is started.
  system1Of(undefined);
  const baseUrl = process.env[BASE_URL_VARIABLE]?.trim() ?? "";
  if (!process.env[API_KEY_VARIABLE]?.trim() && !LOCAL_ADDRESSES.some((local) => baseUrl.startsWith(local))) {
    console.error(`no System 2 key: set ${API_KEY_VARIABLE}, or ${BASE_URL_VARIABLE} to a server on this machine`);
    return USAGE_EXIT;
  }
  const browserOptions = flags.benchmark ? benchmarkBrowserOptions() : {};
  const browser = flags.cdp
    ? await Browser.connect(flags.cdp, browserOptions)
    : await Browser.launch({ ...browserOptions, headless: flags.headless });
  try {
    if (flags.url) await browser.open(flags.url);
    const model = name ? controllerModel(name) : BENCHMARK_MODEL;
    const options = flags.benchmark ? { ...benchmarkControlOptions(Date.now(), new Date()), model } : { model };
    const result = await control(controllerBrowser(browser), task, options);
    console.log(flags.json ? JSON.stringify(result) : result.answer);
    return result.answered ? ANSWERED_EXIT : UNANSWERED_EXIT;
  } finally {
    await browser.close();
  }
}

// A signal ends the process through its exit, so a Chrome this started is stopped with it.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(SIGNAL_EXIT));

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = USAGE_EXIT;
  },
);
