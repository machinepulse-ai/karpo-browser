import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "../../src/index.ts";
import { HAS_CHROME, scripted, site } from "./support.ts";

/**
 * A checkout as Eventbrite's is (2026-11-20): an hCaptcha challenge waits, out of sight, in a container the widget hides
 * (visibility hidden, transparent, 10,000 px above the page) and shows when it asks something. The challenge is an
 * iframe from another site (here localhost, the page being 127.0.0.1), so Chrome puts it in a process of its own.
 */
const CHECKOUT = `<title>Checkout</title><h1>Checkout</h1><button>Register</button>
<div id=box style="visibility: hidden; position: absolute; top: -10000px; left: 0; right: 0; opacity: 0">
  <div><iframe id=challenge title="Main content of the hCaptcha challenge" style="width: 400px; height: 300px; border: 0"></iframe></div>
</div>
<script>challenge.src = "http://localhost:" + location.port + "/challenge";</script>`;
const CHALLENGE = `<title>hCaptcha</title><p>Please try again.</p><button>Verify Answers</button>`;
/** Shows the challenge as the widget does. */
const REVEAL = "box.style.visibility = 'visible'; box.style.opacity = '1'; box.style.top = '0px'";
/** How long the challenge frame is given to attach, and how often that is looked at (ms). */
const FRAME_WAIT_MS = 5_000;
const FRAME_POLL_MS = 100;

describe.skipIf(!HAS_CHROME)("a challenge frame the page hides", () => {
  let local: Awaited<ReturnType<typeof site>>;
  beforeAll(async () => {
    local = await site({ "/": CHECKOUT, "/challenge": CHALLENGE });
  });
  afterAll(() => local.server.close());

  /** The page's lines as `read` gives them, once the challenge frame is attached, after `script` ran (when given). */
  async function lines(script?: string): Promise<string> {
    const browser = await Browser.launch({ headless: true, decider: scripted({ step: () => "DONE" }) });
    try {
      await browser.open(`${local.url}/`);
      for (let waited = 0; waited < FRAME_WAIT_MS && browser.tab.frames().length < 2; waited += FRAME_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, FRAME_POLL_MS));
      }
      expect(browser.tab.frames().length).toBe(2);
      if (script) await browser.tab.evaluate(script);
      return (await browser.read()).lines.join("\n");
    } finally {
      await browser.close();
    }
  }

  it("is not read while hidden: a person sees nothing of it", async () => {
    const read = await lines();
    expect(read).toContain("button Register");
    expect(read).not.toContain("Verify Answers");
    expect(read).not.toContain("Please try again");
  });

  it("is read once the page shows it", async () => {
    const read = await lines(REVEAL);
    expect(read).toContain("Verify Answers");
    expect(read).toContain("Please try again");
  });
});
