/**
 * Carrying out the decision model's step on the page: the element checked first, with one CDP call (still there, the
 * same accessibility role and name as when the page was read, names compared as flat strings), then the one physical
 * action, then the page given time to settle. A step that cannot be carried out is not tried again: what stopped it
 * goes under its line in the recent actions, and the next step reads the page anew.
 */

import { CdpTimeout } from "../browser/cdp.ts";
import type { SettleRules, Tab } from "../browser/tab.ts";
import { InputRefused } from "../browser/tab.ts";
import * as actions from "../contracts/actions.ts";
import type { Texts } from "../contracts/texts.ts";
import {
  EFFECT_CHANGED,
  EFFECT_COVERED,
  EFFECT_FAILED,
  EFFECT_GONE,
  EFFECT_HIDDEN,
  EFFECT_NO_CHANGE,
  EFFECT_NOT_A_FIELD,
  EFFECT_NOT_A_VALUE,
  EFFECT_NOT_TAKEN,
  EFFECT_UNKNOWN,
} from "../contracts/texts.ts";
import { items, member, string } from "../json.ts";
import { shortUrl } from "../reading/state.ts";
import type { Element, SelectOption } from "../reading/tree.ts";
import { sameName, secretKey } from "../reading/tree.ts";
import { SHORT_NAME_CHARS } from "../reading/write.ts";
import { cut, trim } from "../text.ts";
import type { Taken } from "./history.ts";
import { takenOn, takenOnPage } from "./history.ts";

/** How long the page is given to settle after an action, unless the settling says otherwise. */
const SETTLE_MS = 2_000;
/** How far one scroll of the page moves it. */
const SCROLL_STEP_PX = 600;
/** The role of a slider, which takes its value without a click (a click would move it). */
const SLIDER_ROLE = "slider";
/** A link's address, as its element writes it. */
const HREF_OF = "function () { return this.getAttribute('href'); }";
/** The protocols of the addresses a link a click left where it was is opened at. */
const WEB_PROTOCOLS = ["http:", "https:"];

/** Where the boxes a secret is typed into are noted. */
export interface SecretBoxes {
  markSecret(box: string, secret: string): void;
  unmarkSecret(box: string): void;
}

/**
 * How the page is given time to settle after an action, where not as by default: the longest (`SETTLE_MS`, left out)
 * and what counts as quiet, a WAIT's wait for a change too (the tab's own rules, left out).
 */
export interface Settling {
  maxMs?: number | undefined;
  rules?: Readonly<SettleRules> | undefined;
}

/** A step not done, with what stopped it. */
function notDone(taken: Taken, note: string): Taken {
  return { ...taken, note, done: false };
}

/** Whether a box is empty again after a value was typed into it. */
function emptied(expected: string, held: string | undefined): boolean {
  return expected !== "" && (held === undefined || trim(held) === "");
}

/** What carries a step out: the tab, and the words of what is said. */
export class Acting {
  private readonly tab: Tab;
  private readonly texts: Texts;
  private readonly settling: Settling;

  constructor(tab: Tab, texts: Texts, settling: Settling = {}) {
    this.tab = tab;
    this.texts = texts;
    this.settling = settling;
  }

  /**
   * CLICK. A link the click left as it was (the tab at the same address, no tab opened, the page in the same state:
   * `unchanged`) went nowhere, as some pages' own handling of a click does: the address it points to is opened in the
   * tab, as the link would have, and the step reads as a click that led there.
   */
  async click(element: Element, unchanged: () => Promise<boolean>): Promise<Taken> {
    const taken = takenOn(actions.CLICK, element);
    const changed = await this.check(element);
    if (changed !== undefined) return notDone(taken, changed);
    const page = this.tab.url;
    const clicked = await this.ended(taken, () =>
      this.tab.click(element.binding.backendNodeId, element.binding.session),
    );
    if (!clicked.done || clicked.note !== undefined || element.href === undefined) return clicked;
    if (this.tab.url !== page || this.tab.hasOpened()) return clicked;
    const address = await this.addressOf(element, page);
    if (address === undefined || !(await unchanged())) return clicked;
    // What the address comes to (its page, or the browser's error page) is read next, as after a link that works.
    await this.tab.send("Page.navigate", { url: address }).catch(() => {});
    await this.settle();
    return clicked;
  }

  async pressEnter(element: Element): Promise<Taken> {
    const taken = takenOn(actions.PRESS_ENTER, element);
    const changed = await this.check(element);
    if (changed !== undefined) return notDone(taken, changed);
    const { backendNodeId, session } = element.binding;
    return this.ended(taken, async () => {
      await this.tab.send("DOM.focus", { backendNodeId }, session).catch(() => {
        throw new InputRefused("gone");
      });
      await this.tab.press("Enter");
    });
  }

  /**
   * FILL with one of the task's values (its number `n`), read back once the page settled: a box the page emptied as
   * it opened (an autocomplete taking the click as a fresh search) is typed into again key by key; one still empty
   * did not take the value.
   */
  async fill(element: Element, n: number, text: string): Promise<Taken> {
    const taken = { ...takenOn(actions.FILL, element), argument: String(n) };
    const changed = await this.check(element);
    if (changed !== undefined) return notDone(taken, changed);
    const { backendNodeId: node, session } = element.binding;
    if (element.axRole === SLIDER_ROLE) return this.slide(taken, node, session, text);
    let expected: string;
    const began = Date.now();
    try {
      expected = await this.tab.fill(node, session, text);
    } catch (error) {
      return error instanceof CdpTimeout ? this.unknown(taken, error.message) : notDone(taken, this.refused(error));
    }
    await this.settle(began);
    let held = await this.tab.valueOf(node, session);
    if (emptied(expected, held)) {
      try {
        await this.tab.typeKeys(node, session, expected);
        await this.settle();
        held = await this.tab.valueOf(node, session);
      } catch (error) {
        if (error instanceof CdpTimeout) return this.unknown(taken, error.message);
      }
    }
    return emptied(expected, held)
      ? { ...taken, note: this.texts.fill(EFFECT_NOT_TAKEN, { held: held ?? "" }) }
      : taken;
  }

  /**
   * FILL on a slider: set to the value by what the slider shows (`Tab.setSlider`). One that does not come to show the
   * value is back where it was, and the step says what it holds.
   */
  private async slide(taken: Taken, node: number, session: string, text: string): Promise<Taken> {
    const began = Date.now();
    let outcome: { set: boolean; shown: string };
    try {
      outcome = await this.tab.setSlider(node, session, text);
    } catch (error) {
      return error instanceof CdpTimeout ? this.unknown(taken, error.message) : notDone(taken, this.refused(error));
    }
    await this.settle(began);
    // Read once more: a page may put a slider back as it settles.
    const held = outcome.set ? ((await this.tab.sliderShows(node, session, text)) ?? outcome) : outcome;
    return held.set ? taken : notDone(taken, this.texts.fill(EFFECT_NOT_TAKEN, { held: held.shown }));
  }

  /**
   * FILL with a secret of the task: typed as any value is, but never read back (what the box holds stays out of the
   * run's history). The box is noted as a secret's before anything is typed (a typing whose answer is lost may still
   * have happened), and taken off the record only when nothing was sent to the page.
   */
  async fillSecret(element: Element, n: number, secret: string, boxes: SecretBoxes): Promise<Taken> {
    const taken = { ...takenOn(actions.FILL, element), argument: String(n) };
    const changed = await this.check(element);
    if (changed !== undefined) return notDone(taken, changed);
    const { backendNodeId, session, target } = element.binding;
    const box = secretKey(target, backendNodeId);
    boxes.markSecret(box, secret);
    const began = Date.now();
    try {
      await this.tab.fill(backendNodeId, session, secret);
    } catch (error) {
      if (error instanceof CdpTimeout) return this.unknown(taken, error.message);
      if (error instanceof InputRefused) boxes.unmarkSecret(box);
      return notDone(taken, this.refused(error));
    }
    await this.settle(began);
    return taken;
  }

  /** SELECT the option the follow-up chose, by its live index, its text checked first. */
  async select(element: Element, option: SelectOption): Promise<Taken> {
    const taken = { ...takenOn(actions.SELECT, element), argument: cut(option.text, SHORT_NAME_CHARS) };
    const changed = await this.check(element);
    if (changed !== undefined) return notDone(taken, changed);
    const { backendNodeId, session } = element.binding;
    return this.ended(taken, () => this.tab.selectIndex(backendNodeId, session, option.index, option.text));
  }

  /** A scroll of the page (no element) or of a scroll area. */
  async scroll(operation: string, element: Element | undefined): Promise<Taken> {
    const delta = operation === actions.SCROLL_UP ? -SCROLL_STEP_PX : SCROLL_STEP_PX;
    if (!element) return this.ended(takenOnPage(operation), () => this.tab.scroll(delta));
    const taken = takenOn(operation, element);
    const changed = await this.check(element);
    if (changed !== undefined) return notDone(taken, changed);
    const began = Date.now();
    try {
      const moved = await this.tab.scrollBox(element.binding.backendNodeId, element.binding.session, delta);
      if (!moved) return notDone(taken, this.texts.get(EFFECT_NO_CHANGE));
    } catch (error) {
      return error instanceof CdpTimeout ? this.unknown(taken, error.message) : notDone(taken, this.refused(error));
    }
    await this.settle(began);
    return taken;
  }

  escape(): Promise<Taken> {
    return this.ended(takenOnPage(actions.ESCAPE), () => this.tab.press("Escape"));
  }

  refresh(): Promise<Taken> {
    return this.ended(takenOnPage(actions.REFRESH), () => this.tab.send("Page.reload"));
  }

  /** BACK in the tab's own history: to the entry before (by its id). */
  back(entryId: number): Promise<Taken> {
    return this.ended(takenOnPage(actions.BACK), () => this.tab.send("Page.navigateToHistoryEntry", { entryId }));
  }

  /**
   * WAIT: the page left alone until it changes after `since` (when the step's page was read) and settles, by `until`
   * (epoch ms).
   */
  async wait(since: number, until: number): Promise<Taken> {
    await this.tab.changed(since, until, this.settling.rules).catch(() => {});
    return takenOnPage(actions.WAIT);
  }

  /**
   * Gives the page time to settle after an action that began at `since` (its own requests are waited for), as the
   * settling says; a page that cannot be asked is read as it is next.
   */
  private async settle(since?: number): Promise<void> {
    const { maxMs = SETTLE_MS, rules } = this.settling;
    await (since === undefined
      ? this.tab.settle(maxMs, undefined, rules)
      : this.tab.settleAfter(since, maxMs, rules)
    ).catch(() => {});
  }

  /**
   * The address a link points to: its `href` resolved against the page's address `page`, when it is a web page's other
   * than this one (its fragment aside).
   */
  private async addressOf(element: Element, page: string): Promise<string | undefined> {
    const { backendNodeId, session } = element.binding;
    const href = await this.tab.on(backendNodeId, session, HREF_OF).catch(() => undefined);
    const url = typeof href === "string" ? URL.parse(href, page) : null;
    if (!url || !WEB_PROTOCOLS.includes(url.protocol)) return undefined;
    return shortUrl(url.href) === shortUrl(page) ? undefined : url.href;
  }

  /** Undefined when the element is the one the model chose; else what to say instead of acting. */
  private async check(element: Element): Promise<string | undefined> {
    const node = element.binding.backendNodeId;
    const params = { backendNodeId: node, fetchRelatives: false };
    const answer = await this.tab
      .send("Accessibility.getPartialAXTree", params, element.binding.session)
      .catch(() => undefined);
    const nodes = items(member(answer, "nodes"));
    const found = nodes.find((candidate) => member(candidate, "backendDOMNodeId") === node) ?? nodes[0];
    if (found === undefined) return this.texts.get(EFFECT_GONE);
    const field = (key: string) => string(member(member(found, key), "value")) ?? "";
    const [role, name] = [field("role"), field("name")];
    if ((element.axRole === "" || role === element.axRole) && sameName(name, element.axName)) return undefined;
    return this.texts.fill(EFFECT_CHANGED, { now: cut(trim(`${role} ${name}`), SHORT_NAME_CHARS) });
  }

  /** What to say of an input the page did not take. */
  private refused(error: unknown): string {
    if (error instanceof InputRefused) {
      switch (error.reason) {
        case "covered":
          return this.texts.fill(EFFECT_COVERED, { by: error.detail });
        case "hidden":
          return this.texts.get(EFFECT_HIDDEN);
        case "gone":
        case "no_option":
          return this.texts.get(EFFECT_GONE);
        case "not_a_field":
          return this.texts.get(EFFECT_NOT_A_FIELD);
        case "not_a_value":
          return this.texts.fill(EFFECT_NOT_A_VALUE, { kind: error.detail });
      }
    }
    return this.texts.fill(EFFECT_FAILED, { reason: error instanceof Error ? error.message : String(error) });
  }

  /** The step's outcome: done (the page settled), or not done with what stopped it. */
  private async ended(taken: Taken, act: () => Promise<unknown>): Promise<Taken> {
    const began = Date.now();
    try {
      await act();
    } catch (error) {
      return error instanceof CdpTimeout ? this.unknown(taken, error.message) : notDone(taken, this.refused(error));
    }
    await this.settle(began);
    return taken;
  }

  /**
   * A step whose command the page did not answer in time: it may still have reached the page (a Pay whose page is
   * busy), so it is not called failed, and its page is read as it settles.
   */
  private async unknown(taken: Taken, reason: string): Promise<Taken> {
    await this.settle();
    return { ...taken, note: this.texts.fill(EFFECT_UNKNOWN, { reason }) };
  }
}
