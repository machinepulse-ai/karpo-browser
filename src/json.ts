/** A browser's JSON payloads (DOM snapshots, accessibility nodes) read without trusting their shape. */

/** The largest integer a JSON number holds exactly. */
const MAX_EXACT_INTEGER = 9_007_199_254_740_991;

/** An object's member; undefined when the value is no object or has none. */
export function member(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Whether an object names a member, whatever it holds. */
export function has(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key);
}

/** An array's items; none when the value is no array. */
export function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A value as a number; undefined for anything else. */
export function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** A value as an integer (a node index or id); undefined for anything else. */
export function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_EXACT_INTEGER
    ? value
    : undefined;
}

/** A value as a string; undefined for anything else. */
export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Whether a value is `true` or the string "true". */
export function yes(value: unknown): boolean {
  return value === true || value === "true";
}
