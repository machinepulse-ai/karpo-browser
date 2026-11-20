/**
 * Bringing a text of the page into view, as a person scrolls to it: the first drawn element whose own words hold the
 * text (case, thousands separators and runs of spaces aside) is scrolled to the middle of the viewport. A value split
 * over several elements ("$", "98", ".29") is found in the element that holds them all, up to a few levels above.
 *
 * Looked for loosely, a text not found as it is written is looked for with its punctuation and case folded ("Monthly
 * price: $350" in a label and a value apart), its amounts keeping their currency, decimals and percent sign, when it has
 * words; then by each amount it holds alone that says what it is ("$350", "4.5", "20%", "20/mo"; never a bare number,
 * a day, a year or a count being on too much of any page), the longest first: of the drawn elements that hold it, the
 * one with the fewest characters is scrolled to.
 *
 * Scrolled to at once, the scroll is done when the script returns, as it may not be otherwise: a page whose style
 * scrolls smoothly (`scroll-behavior: smooth`) still moves for a while after.
 */

/** How many levels above a text node an element holding the whole text is looked for. */
const LEVELS_UP = 3;
/** The longest words an element may hold and still be the one scrolled to (a whole region is too vague). */
const MOST_CHARS = 400;

/**
 * The loose search, after the search as written found nothing: each try is a test a text node must pass to be looked
 * above (`near`) and one the element's words must pass (`holds`).
 */
const LOOSE_SEARCH = `  const longest = (a, b) => (b.length > a.length ? b : a);
  // Words and amounts in order, other punctuation dropped: an amount keeps its currency, decimals and percent sign.
  const fold = (s) => (norm(s).match(/[$€£¥₹]?\\d+(?:\\.\\d+)?%?|\\p{L}+/gu) || []).join(" ");
  // An amount stands alone: no digit just before it or after it, no decimal point before it, no decimals after it.
  const holdsValue = (text, value) => {
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
      if (!/[\\d.]/.test(text[at - 1] || "") && !/^\\.?\\d/.test(text.slice(at + value.length))) return true;
    }
    return false;
  };
  const tries = [];
  const folded = fold(want);
  // A text without words ("$350", "20 %") is left to the amounts: its punctuation is all that tells it apart.
  if (/\\p{L}/u.test(folded)) {
    const part = (folded.match(/\\d+/g) || folded.split(" ")).reduce(longest);
    const holds = (t) => (" " + fold(t) + " ").includes(" " + folded + " ");
    tries.push({ near: (t) => fold(t).includes(part), holds });
  }
  // Only an amount with a currency, decimals, a percent sign or a unit: a bare number is on too much of any page.
  const amounts = want.match(/[$€£¥₹]?\\d+(?:\\.\\d+)?(?:%|\\/[a-z]+)?/g) || [];
  const values = new Set(amounts.filter((value) => /[$€£¥₹.%/]/.test(value)));
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    const holds = (t) => holdsValue(norm(t), value);
    tries.push({ near: holds, holds });
  }
  for (const { near, holds } of tries) {
    let best = null;
    const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      if (!near(node.textContent || "")) continue;
      let el = node.parentElement;
      for (let level = 0; el && level < ${LEVELS_UP}; level++, el = el.parentElement) {
        const words = el.innerText || "";
        if (words.length > ${MOST_CHARS}) break;
        if (!holds(words)) continue;
        if (drawn(el) && (!best || words.length < best.chars)) best = { el, chars: words.length };
        break;
      }
    }
    if (best) {
      best.el.scrollIntoView(into);
      return true;
    }
  }
`;

/**
 * The expression that scrolls to `wanted` on the page and returns whether it found it; `loose`, loosely as well;
 * `instant`, at once whatever scroll behaviour the page's style gives.
 */
export function revealScript(wanted: string, loose = false, instant = false): string {
  return `(() => {
  const into = { block: "center", inline: "nearest"${instant ? ', behavior: "instant"' : ""} };
  const norm = (s) => s.toLowerCase().replace(/,/g, "").replace(/\\s+/g, " ").trim();
  const want = norm(${JSON.stringify(wanted)});
  if (!want || !document.body) return false;
  const runs = want.match(/\\d+/g) || [want];
  const key = runs.reduce((a, b) => (b.length > a.length ? b : a));
  const drawn = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!norm(node.textContent || "").includes(key)) continue;
    let el = node.parentElement;
    for (let level = 0; el && level < ${LEVELS_UP}; level++, el = el.parentElement) {
      const words = el.innerText || "";
      if (words.length > ${MOST_CHARS}) break;
      if (!norm(words).includes(want)) continue;
      if (!drawn(el)) break;
      el.scrollIntoView(into);
      return true;
    }
  }
${loose ? LOOSE_SEARCH : ""}  return false;
})()`;
}
