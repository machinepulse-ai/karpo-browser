#!/usr/bin/env node
/**
 * The command line: works one goal on a page with the decision model alone (`run`), or serves the browser as tools for
 * an agent (`mcp`).
 *
 * ```
 * karpo-browser run --url https://www.example.com --goal "Open the contact page" --value "search=contact"
 * karpo-browser mcp
 * ```
 */

import { parseArgs } from "node:util";
import { DONE } from "./contracts/statuses.ts";
import { Browser, system1Of } from "./index.ts";
import { serve } from "./mcp.ts";

/** The exit code of a process a signal ended. */
const SIGNAL_EXIT = 130;

const USAGE = `usage: karpo-browser run --url <address> --goal <goal> [options]
       karpo-browser mcp

run works one goal on a page with the decision model alone. mcp serves the browser as tools for an agent (Model
Context Protocol, on stdin and stdout): BROWSER_CDP_URL works a browser that runs already, BROWSER_HEADLESS=1 starts
Chrome without a window.

  --url <address>        the page to start on
  --goal <goal>          the end state to reach, and the limits to keep
  --value <name=text>    a value the model may type (repeatable)
  --secret <name=VAR>    a value typed without any model seeing it, read from the environment variable VAR (repeatable)
  --cdp <ws address>     work a browser that runs already (its DevTools WebSocket address) instead of starting Chrome
  --headless             start Chrome without a window
  --json                 print the result as JSON alone

System 1 is the decision model at SYSTEM1_URL (default: OpenRouter's decisions endpoint), named by SYSTEM1_MODEL, with
the key in SYSTEM1_API_KEY.`;

/** `name=text` pairs as a record; a pair without a name or `=` is refused. */
function pairs(given: readonly string[], what: string): Record<string, string> {
  return Object.fromEntries(
    given.map((pair) => {
      const at = pair.indexOf("=");
      if (at <= 0) throw new Error(`${what} ${JSON.stringify(pair)} is not name=text`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

/** The secrets named by environment variable, read from the environment. */
function secretsOf(named: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(named).map(([name, variable]) => {
      const text = process.env[variable];
      if (text === undefined)
        throw new Error(`the secret ${name} names ${variable}, which the environment does not set`);
      return [name, text];
    }),
  );
}

async function main(): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      value: { type: "string", multiple: true, default: [] },
      secret: { type: "string", multiple: true, default: [] },
      cdp: { type: "string" },
      headless: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  if (command === "mcp" && !flags.help) {
    await serve();
    return 0;
  }
  const { url, goal } = flags;
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (command !== "run" || !url || !goal) {
    console.error(USAGE);
    return 2;
  }
  // What was given, and System 1's settings, are checked before a browser is started for them.
  const secrets = secretsOf(pairs(flags.secret, "the secret"));
  const values = pairs(flags.value, "the value");
  system1Of(undefined);
  const browser = flags.cdp ? await Browser.connect(flags.cdp) : await Browser.launch({ headless: flags.headless });
  try {
    await browser.open(url);
    const result = await browser.run(
      { goal, values, secrets },
      {
        onStep: (step) => {
          if (!flags.json) console.log(`${step.step}. ${step.key}${step.note ? ` (${step.note})` : ""}`);
        },
      },
    );
    if (flags.json) console.log(JSON.stringify(result));
    else {
      console.log(`${result.status}: ${result.detail}`);
      console.log(`${result.title} (${result.url}), ${result.steps} steps, ${result.seconds.toFixed(1)} s`);
    }
    return result.status === DONE ? 0 : 1;
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
    process.exitCode = 2;
  },
);
