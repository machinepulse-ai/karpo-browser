/** Filter the full accessible reading before applying the tool's output limit. */
export function pageExcerpt(lines: readonly string[], limit: number, containing?: unknown): string {
  let matches = lines;
  let count = "";
  if (containing !== undefined) {
    if (
      !Array.isArray(containing) ||
      !containing.length ||
      !containing.every((s) => typeof s === "string" && s.trim())
    ) {
      throw new Error("containing must be a non-empty array of non-empty strings");
    }
    const terms = containing.map((term: string) => term.trim().toLowerCase());
    matches = lines.filter((line) => {
      const text = line.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    count = `${matches.length} matching line${matches.length === 1 ? "" : "s"}`;
  }
  const excerpt = matches.slice(0, limit);
  if (count) excerpt.unshift(count);
  if (matches.length > limit) excerpt.push(`(${matches.length - limit} more lines)`);
  return excerpt.join("\n");
}
