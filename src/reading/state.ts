/**
 * The state a page is in, as one identifier: two readings have the same one when the page holds the same things,
 * wherever it is scrolled. The run's history counts visits and tries by it.
 *
 * The identifier is SipHash-1-3 (zero keys) over the page's facts, each text followed by 0xFF: the same 16 hex
 * digits the recordings' steps name a state by.
 */

import type { PageTree } from "./tree.ts";
import { Keep } from "./tree.ts";

/** What the web's pages start with. */
const WEB_SCHEMES = ["http://", "https://"];
/** What separates an element's facts in its entry. */
const FACT_SEPARATOR = "\u0001";
/** What ends a text in the hashed bytes: a byte no UTF-8 text holds. */
const TEXT_END = 0xff;
const UTF8 = new TextEncoder();
const MASK_64 = 0xffff_ffff_ffff_ffffn;

/** Whether an address is a web page a run can work on. */
export function isWeb(url: string): boolean {
  return WEB_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/** An address as the model reads it: without its scheme and fragment ("www.tablecheck.com/en/japan"). */
export function shortUrl(url: string): string {
  const page = url.split("#", 1)[0] ?? "";
  const scheme = WEB_SCHEMES.find((prefix) => page.startsWith(prefix));
  return (scheme ? page.slice(scheme.length) : page).replace(/\/+$/, "");
}

/**
 * The page's state: its address (less its fragment), its title, its elements by what they are and hold (in no order:
 * a focus or a reorder is no new state), and its texts. Elements that only fill the viewport up are left out, as are
 * positions: a scroll is no new state.
 */
export function stateOf(tree: PageTree): string {
  const elements: Uint8Array[] = [];
  for (const element of tree.elements) {
    if (element.keep === Keep.Filled) continue;
    const held =
      element.kind.kind === "select"
        ? element.kind.options.find((option) => option.selected)?.text
        : (element.value ?? element.secretLength?.toString());
    const states = element.states.map(
      ([name, value]) => `(${quoted(name)}, ${value === undefined ? "None" : `Some(${quoted(value)})`})`,
    );
    elements.push(UTF8.encode([element.role, element.name, `[${states.join(", ")}]`, held ?? ""].join(FACT_SEPARATOR)));
  }
  elements.sort(compareBytes);
  const hash = new SipHash13();
  hash.text(UTF8.encode(shortUrl(tree.url)));
  hash.text(UTF8.encode(tree.title));
  hash.length(elements.length);
  for (const element of elements) hash.text(element);
  for (const { line } of tree.lines) {
    if (line.kind === "text") hash.text(UTF8.encode(line.text));
    else if (line.kind === "heading") hash.text(UTF8.encode(line.name));
  }
  return hash.finish().toString(16).padStart(16, "0");
}

/**
 * The page's state as `stateOf` gives it, what changes on the page by itself left out (`PageTree.changing`: those
 * lines, and the elements they are): a page whose carousel turned or whose timer ticked is in the same one. What the
 * run's check for going in circles compares; a request names the page's state by `stateOf`.
 */
export function steadyStateOf(tree: PageTree): string {
  const changing = new Set<number>();
  for (const at of tree.changing) {
    const line = tree.lines[at]?.line;
    if (line?.kind === "element") changing.add(line.element);
  }
  // `stateOf` reads the elements, the texts and the headings: the lines of the elements are left out with the rest.
  return stateOf({
    ...tree,
    elements: tree.elements.filter((_, index) => !changing.has(index)),
    lines: tree.lines.filter(({ line }, at) => line.kind !== "element" && !tree.changing.has(at)),
  });
}

/** A text in double quotes, what would end or break the quoting escaped. */
function quoted(text: string): string {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (code === 0) out += "\\0";
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += character;
  }
  return `${out}"`;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** SipHash-1-3 with zero keys over a stream of bytes. */
class SipHash13 {
  private v0 = 0x736f6d6570736575n;
  private v1 = 0x646f72616e646f6dn;
  private v2 = 0x6c7967656e657261n;
  private v3 = 0x7465646279746573n;
  private readonly tail = new Uint8Array(8);
  private tailLength = 0;
  private total = 0;

  /** A text's bytes, then the byte that ends it. */
  text(bytes: Uint8Array): void {
    this.write(bytes);
    this.write(Uint8Array.of(TEXT_END));
  }

  /** A count, as eight little-endian bytes. */
  length(count: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(count), true);
    this.write(bytes);
  }

  finish(): bigint {
    let last = BigInt(this.total & 0xff) << 56n;
    for (let i = 0; i < this.tailLength; i += 1) last |= BigInt(this.tail[i]!) << BigInt(8 * i);
    this.block(last);
    this.v2 ^= 0xffn;
    this.round();
    this.round();
    this.round();
    return (this.v0 ^ this.v1 ^ this.v2 ^ this.v3) & MASK_64;
  }

  private write(bytes: Uint8Array): void {
    this.total += bytes.length;
    for (const byte of bytes) {
      this.tail[this.tailLength] = byte;
      this.tailLength += 1;
      if (this.tailLength === 8) {
        this.block(new DataView(this.tail.buffer).getBigUint64(0, true));
        this.tailLength = 0;
      }
    }
  }

  private block(m: bigint): void {
    this.v3 ^= m;
    this.round();
    this.v0 ^= m;
  }

  private round(): void {
    const rotl = (x: bigint, bits: bigint) => ((x << bits) | (x >> (64n - bits))) & MASK_64;
    this.v0 = (this.v0 + this.v1) & MASK_64;
    this.v1 = rotl(this.v1, 13n) ^ this.v0;
    this.v0 = rotl(this.v0, 32n);
    this.v2 = (this.v2 + this.v3) & MASK_64;
    this.v3 = rotl(this.v3, 16n) ^ this.v2;
    this.v0 = (this.v0 + this.v3) & MASK_64;
    this.v3 = rotl(this.v3, 21n) ^ this.v0;
    this.v2 = (this.v2 + this.v1) & MASK_64;
    this.v1 = rotl(this.v1, 17n) ^ this.v2;
    this.v2 = rotl(this.v2, 32n);
  }
}
