/**
 * The statuses a run's result carries: DONE's, an ending's (its key in lower case), and the ones the run ends on by
 * itself (its limits, a stop from outside, a failure of its own, going in circles).
 */
export const DONE = "done";
export const LOOPING = "looping";
export const LIMIT = "limit";
export const INTERRUPTED = "interrupted";
export const FAILED = "failed";
