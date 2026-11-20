/** A local Chrome started for the framework: its own profile directory, its DevTools port chosen by the browser. */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The variable that names the browser to start, when it is none of the usual ones. */
const CHROME_PATH_VARIABLE = "CHROME_PATH";
/** Where Chrome and Chromium are installed, by platform. */
const USUAL_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};
/** The file Chrome writes its DevTools port and browser path to, in its profile directory. */
const PORT_FILE = "DevToolsActivePort";
/** The file whole: the port on its first line, the browser's DevTools path (it ends with the browser's id) on its second. */
const PORT_FILE_WHOLE =
  /^(\d+)\r?\n(\/devtools\/browser\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;
/** How long Chrome is given to stop before it is killed. */
const STOP_TIMEOUT_MS = 3_000;
/** How long Chrome is given to start, looked at this often. */
const START_TIMEOUT_MS = 20_000;
const START_LOOK_MS = 50;
/** The viewport a started Chrome has. */
const WINDOW_SIZE = "1280,800";

export interface LaunchOptions {
  /** The browser's executable; else `CHROME_PATH`, else where Chrome is usually installed. */
  executablePath?: string | undefined;
  /** Without a window. */
  headless?: boolean | undefined;
  /** More command-line switches. */
  args?: readonly string[] | undefined;
}

/** A started Chrome: where its DevTools answer, and how to stop it. */
export interface LocalChrome {
  wsUrl: string;
  close(): Promise<void>;
}

function executable(options: LaunchOptions): string {
  const named = options.executablePath ?? process.env[CHROME_PATH_VARIABLE];
  const found = named ?? USUAL_PATHS[process.platform]?.find((path) => existsSync(path));
  if (!found) throw new Error(`no Chrome found: set ${CHROME_PATH_VARIABLE} or pass executablePath`);
  return found;
}

/** Whether the process has ended: by itself (an exit code) or by a signal. */
function ended(chrome: ChildProcess): boolean {
  return chrome.exitCode !== null || chrome.signalCode !== null;
}

/** Starts Chrome with a profile of its own and waits until its DevTools answer. */
export async function launchChrome(options: LaunchOptions = {}): Promise<LocalChrome> {
  const path = executable(options);
  const profile = await mkdtemp(join(tmpdir(), "browser-profile-"));
  const chrome = spawn(
    path,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${WINDOW_SIZE}`,
      ...(options.headless ? ["--headless=new"] : []),
      ...(options.args ?? []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // A browser that cannot be started says so through this event; unheard, it would end the process.
  let failure: Error | undefined;
  chrome.once("error", (error) => {
    failure = error;
  });
  // The browser and its profile do not outlive the process that started them.
  const atExit = () => {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  };
  process.once("exit", atExit);
  const close = async () => {
    process.off("exit", atExit);
    if (!ended(chrome) && !failure) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      // A browser stuck while shutting down is not waited for without end.
      const stuck = setTimeout(() => chrome.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(stuck);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  for (const until = Date.now() + START_TIMEOUT_MS; Date.now() < until && !ended(chrome) && !failure; ) {
    const written = await readFile(join(profile, PORT_FILE), "utf8").catch(() => "");
    // The file is written in two steps: it is read only once it holds the port and the browser's whole path.
    const whole = PORT_FILE_WHOLE.exec(written);
    if (whole) return { wsUrl: `ws://127.0.0.1:${whole[1]}${whole[2]}`, close };
    await new Promise((resolve) => setTimeout(resolve, START_LOOK_MS));
  }
  await close();
  throw new Error(`Chrome did not start (${path})${failure ? `: ${failure.message}` : ""}`);
}
