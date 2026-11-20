/**
 * The page a run works on, as it moves between a browser's tabs: a click may open a new tab (the run goes on there),
 * a window that closes itself leaves the run on the page that opened it, and going back from a tab a link opened
 * returns to that page. It also remembers, for as long as the browser is worked, the boxes a secret was typed into.
 */

import type { Connection } from "./cdp.ts";
import { Tab } from "./tab.ts";

/** A tab the run moved to, with the one that opened it. */
interface Opened {
  opener: Tab;
  /**
   * Whether its page can reach the one that opened it (`window.opener`): a sign-in or payment window that answers
   * its opener does, and neither is closed while the other is in use.
   */
  reachesOpener: boolean;
}

export class Pages {
  private readonly connection: Connection;
  private tab: Tab;
  private readonly openers = new Map<string, Opened>();
  /** The boxes a secret was typed into, each with the tab it is on. */
  private readonly typed = new Map<string, string>();
  /** The secrets typed, as typed: what a page shows of them elsewhere is masked too. */
  private readonly texts = new Set<string>();

  constructor(connection: Connection, tab: Tab) {
    this.connection = connection;
    this.tab = tab;
  }

  /**
   * The tab the run is on now. A window that closed itself (a sign-in or payment window that finished) leaves the run
   * on the page that opened it.
   */
  current(): Tab {
    for (let opened = this.openers.get(this.tab.targetId); this.tab.gone && opened; ) {
      this.openers.delete(this.tab.targetId);
      this.tab.close();
      this.tab = opened.opener;
      this.connection.send("Target.activateTarget", { targetId: this.tab.targetId }).catch(() => {});
      opened = this.openers.get(this.tab.targetId);
    }
    return this.tab;
  }

  /**
   * After a page action: the last tab it opened becomes the run's. The run keeps the tab it is on and the one before:
   * the other tabs the action opened and the tab before the opener close, but a window that answers the page that
   * opened it and a page a secret was typed into.
   */
  async adoptOpened(): Promise<void> {
    const opened = this.tab.takeOpened();
    // The last tab the action opened that is still there: one that closed again by now is passed over.
    let next = opened.pop();
    let adopted: Tab | undefined;
    for (; next; next = opened.pop()) {
      adopted = await Tab.attach(this.connection, next.targetId).catch(() => undefined);
      if (adopted && !adopted.gone) break;
      adopted?.close();
      adopted = undefined;
    }
    if (!next || !adopted) return;
    const opener = this.tab;
    this.openers.set(next.targetId, { opener, reachesOpener: next.reachesOpener });
    this.tab = adopted;
    await this.connection.send("Target.activateTarget", { targetId: next.targetId }).catch(() => {});
    for (const other of opened) if (!other.reachesOpener) this.closeTarget(other.targetId);
    const before = this.openers.get(opener.targetId);
    if (before && !before.reachesOpener && !this.kept(before.opener.targetId)) {
      this.openers.delete(opener.targetId);
      before.opener.close();
      this.closeTarget(before.opener.targetId);
    }
  }

  /** Whether a tab stays open though the run moved on: a secret was typed into it, or it answers the page that opened it. */
  private kept(targetId: string): boolean {
    return this.holdsSecret(targetId) || this.openers.get(targetId)?.reachesOpener === true;
  }

  /**
   * Whether BACK can return to the page that opened the run's tab: a tab a link opened, its opener still there, and
   * no secret typed into it (closing it would lose what was entered).
   */
  canGoBackToOpener(): boolean {
    const opened = this.openers.get(this.tab.targetId);
    return opened !== undefined && !opened.reachesOpener && !opened.opener.gone && !this.holdsSecret(this.tab.targetId);
  }

  /** BACK to the page that opened the run's tab: that page becomes the run's tab, in front, and this one closes. */
  async backToOpener(): Promise<void> {
    const opened = this.openers.get(this.tab.targetId);
    if (!opened) throw new Error("no page opened this tab");
    // Brought to the front first: when that page is gone after all, the run stays where it is.
    await this.connection.send("Target.activateTarget", { targetId: opened.opener.targetId });
    const left = this.tab;
    this.openers.delete(left.targetId);
    this.tab = opened.opener;
    left.close();
    this.closeTarget(left.targetId);
  }

  /** The boxes a secret was typed into, each by its key: every reading masks them. */
  typedSecrets(): ReadonlySet<string> {
    return new Set(this.typed.keys());
  }

  /** Whether a secret was typed anywhere in the browser while it was worked. */
  get secretTyped(): boolean {
    return this.typed.size > 0;
  }

  /** The secrets typed while the browser was worked. */
  typedTexts(): string[] {
    return [...this.texts];
  }

  /** Notes a box on the run's tab as one a secret is typed into, and the secret as one to mask. */
  markSecret(box: string, secret: string): void {
    this.typed.set(box, this.tab.targetId);
    this.texts.add(secret);
  }

  /** Takes a box off the record: nothing was typed into it. */
  unmarkSecret(box: string): void {
    this.typed.delete(box);
  }

  private holdsSecret(targetId: string): boolean {
    return [...this.typed.values()].includes(targetId);
  }

  /** Closes a tab without waiting for the browser. */
  private closeTarget(targetId: string): void {
    this.connection.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}
