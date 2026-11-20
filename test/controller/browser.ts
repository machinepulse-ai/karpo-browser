/**
 * The library's Browser as the controller works it: the same browser, its tab's address given only when it is a web
 * page.
 */
import type { Browser } from "../../src/index.ts";
import { isWeb } from "../../src/index.ts";
import type { ControllerBrowser } from "./controller.ts";

export function controllerBrowser(browser: Browser): ControllerBrowser {
  return {
    url: () => (isWeb(browser.tab.url) ? browser.tab.url : ""),
    open: (url) => browser.open(url),
    run: (input, controls) => browser.run(input, controls),
    read: () => browser.read(),
    act: (action) => browser.act(action),
    reveal: (text, instant) => browser.reveal(text, instant),
    screenshot: () => browser.screenshot(),
    readableScreenshot: () => browser.readableScreenshot(),
    compare: (urls, lookFor) => browser.compare(urls, lookFor),
  };
}
