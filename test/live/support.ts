/** What the live tests share: a local site, a headless Chrome when the machine has one, and a decider that answers by rule. */

import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AskContext, Decider, DecisionRequest } from "../../src/index.ts";

/** Whether this machine has a Chrome the tests can start. */
export const HAS_CHROME =
  process.env.CHROME_PATH !== undefined ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].some(
    (path) => existsSync(path),
  );

/** A local site: its pages by path, and its address. */
export async function site(pages: Readonly<Record<string, string>>): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const page = pages[request.url ?? "/"];
    response.statusCode = page === undefined ? 404 : 200;
    response.setHeader("content-type", "text/html").end(`<!doctype html>${page ?? "not found"}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

/** What a rule reads of a request: the page's lines, and the number of the element a line names. */
export interface Asked {
  lines: readonly string[];
  numberOf(words: string): string;
  has(words: string): boolean;
}

/**
 * A decider that answers by rule: `step` gives the step's option, `value` and `option` a follow-up's. It keeps every
 * request it was asked.
 */
export function scripted(rules: {
  step: (asked: Asked) => string;
  value?: (instructions: string) => string;
  option?: (criteria: Record<string, string>) => string;
}): Decider & { requests: { request: DecisionRequest; context: AskContext }[] } {
  const requests: { request: DecisionRequest; context: AskContext }[] = [];
  return {
    requests,
    async ask(request, context) {
      requests.push({ request, context });
      const questions = request.questions;
      if (questions.value)
        return { answers: { value: { choice: rules.value?.(questions.value.instructions) ?? "NONE" } } };
      if (questions.option?.type === "choice")
        return { answers: { option: { choice: rules.option?.(questions.option.criteria) ?? "NONE" } } };
      const lines = request.state.page.elements;
      const choice = rules.step({
        lines,
        has: (words) => lines.some((line) => line.includes(words)),
        numberOf: (words) => /^\s*(\d+) /.exec(lines.find((line) => line.includes(words)) ?? "")?.[1] ?? "?",
      });
      return { answers: { step: { choice, probabilities: { [choice]: 0.9 } }, looping: { noul: 0.01 } } };
    },
  };
}
