/** A `${NAME}` a launcher passed on as it is, because the variable it names was not set. */
const UNEXPANDED = /^\$\{[^}]*\}$/;

/** An environment variable's value: none when it is unset, empty, or a reference a launcher did not expand. */
export function setting(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !UNEXPANDED.test(value) ? value : undefined;
}
