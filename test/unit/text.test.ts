import { describe, expect, it } from "vitest";
import { asciiLower, collapse, cut, decimal, integer, length, sameButAsciiCase, trim, words } from "../../src/text.ts";

describe("text", () => {
  it("counts and cuts by characters, not UTF-16 units", () => {
    expect(length("a😀b")).toBe(3);
    expect(cut("a😀bcd", 3)).toBe("a😀…");
    expect(cut("abc", 3)).toBe("abc");
  });

  it("takes Unicode white space as white space: U+0085, not U+FEFF", () => {
    expect(words(" a\u0085b c﻿d ")).toEqual(["a", "b", "c﻿d"]);
    expect(collapse("  First   name\n")).toBe("First name");
    expect(trim("﻿ a 　")).toBe("﻿ a");
  });

  it("compares and lowers ASCII letters alone", () => {
    expect(sameButAsciiCase("PASSWORD", "password")).toBe(true);
    expect(sameButAsciiCase("É", "é")).toBe(false);
    expect(asciiLower("ÉA")).toBe("Éa");
  });

  it("reads a number only when the text is one, whole", () => {
    expect(decimal("0.5")).toBe(0.5);
    expect(decimal(".5")).toBe(0.5);
    expect(decimal("1e2")).toBe(100);
    expect(decimal("")).toBeUndefined();
    expect(decimal("1px")).toBeUndefined();
    expect(decimal(" 1")).toBeUndefined();
    expect(integer("+7")).toBe(7n);
    expect(integer("7.0")).toBeUndefined();
    expect(integer("9223372036854775808")).toBeUndefined();
  });
});
