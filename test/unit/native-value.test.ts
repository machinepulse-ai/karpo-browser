import { describe, expect, it } from "vitest";
import { firstNumber, nativeValue } from "../../src/browser/native-value.ts";

describe("a native input's value", () => {
  it("reads a date only when it can be read one way", () => {
    expect(nativeValue("date", "2026-12-25")).toBe("2026-12-25");
    expect(nativeValue("date", "25/12/2026")).toBe("2026-12-25");
    expect(nativeValue("date", "Dec 25th, 2026")).toBe("2026-12-25");
    expect(nativeValue("date", "Friday, 25 December 2026")).toBe("2026-12-25");
    expect(nativeValue("date", "03/04/2026")).toBeUndefined();
    expect(nativeValue("date", "2026-02-30")).toBeUndefined();
  });

  it("reads a time, a month, a week and a number", () => {
    expect(nativeValue("time", "7:45 pm")).toBe("19:45");
    expect(nativeValue("time", "7 p.m.")).toBe("19:00");
    expect(nativeValue("time", "19")).toBeUndefined();
    expect(nativeValue("month", "December 2026")).toBe("2026-12");
    expect(nativeValue("week", "2026-w05")).toBe("2026-W05");
    expect(nativeValue("number", "1,250.5")).toBe("1250.5");
    expect(nativeValue("datetime-local", "Dec 25 2026 at 7:45 pm")).toBe("2026-12-25T19:45");
    expect(nativeValue("text", "x")).toBeUndefined();
  });

  it("finds the first number in a text", () => {
    expect(firstNumber("$1,250.5 a night")).toBe(1250.5);
    expect(firstNumber("none")).toBeUndefined();
  });
});
