/**
 * Where a browser's time went, for whoever records a task: its settles by what they followed (how many, how long, how
 * each ended) and its page captures. Kept on the connection, so every tab of the browser adds to the same record.
 */

/** The settles that followed one kind of thing. */
export interface SettleTimes {
  count: number;
  ms: number;
  /** How many ended each way (tab.ts SettleEnd). */
  ends: Record<string, number>;
}

/** A browser's timings as a plain record. */
export interface TimingsRecord {
  settles: Record<string, SettleTimes>;
  captures: { count: number; ms: number };
}

export class Timings {
  private readonly settles = new Map<string, SettleTimes>();
  private readonly captures = { count: 0, ms: 0 };

  /** A settle after `kind` (an action, an open, a wait) took `ms` and ended `end`. */
  settled(kind: string, ms: number, end: string): void {
    const times = this.settles.get(kind) ?? { count: 0, ms: 0, ends: {} };
    times.count++;
    times.ms += ms;
    times.ends[end] = (times.ends[end] ?? 0) + 1;
    this.settles.set(kind, times);
  }

  /** A capture of the page took `ms`. */
  captured(ms: number): void {
    this.captures.count++;
    this.captures.ms += ms;
  }

  record(): TimingsRecord {
    return { settles: Object.fromEntries(this.settles), captures: { ...this.captures } };
  }
}
