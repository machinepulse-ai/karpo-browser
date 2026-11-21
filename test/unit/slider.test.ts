import { describe, expect, it } from "vitest";
import type { SliderState } from "../../src/browser/slider.ts";
import { pressesFor, readSlider, shown, shownNumber, shows, sliderTarget } from "../../src/browser/slider.ts";

function slider(value: string, valueText?: string): SliderState {
  return { native: true, value, valueText, vertical: false, disabled: false, focused: true };
}

describe("a slider's target", () => {
  it("is a number when the text holds one that is the value by itself", () => {
    expect(sliderTarget("20").number).toBe(20);
    expect(sliderTarget("$20").number).toBe(20);
    expect(sliderTarget("under $1,250.50").number).toBe(1250.5);
    expect(sliderTarget("22 years").number).toBe(22);
    expect(sliderTarget("-5").number).toBe(-5);
    expect(sliderTarget("20%").number).toBe(20);
  });

  it("is words alone for a time of day, a number with a magnitude, and plain words", () => {
    expect(sliderTarget("2:00 PM").number).toBeUndefined();
    expect(sliderTarget("100K").number).toBeUndefined();
    expect(sliderTarget("1.5k").number).toBeUndefined();
    expect(sliderTarget("noon").number).toBeUndefined();
  });
});

describe("what a slider shows", () => {
  it("is its own words for the value, else the value", () => {
    expect(shown(slider("7", "Fri, 02:00 PM"))).toBe("Fri, 02:00 PM");
    expect(shown(slider("30"))).toBe("30");
  });

  it("is a number when it shows a number alone", () => {
    expect(shownNumber(slider("30"))).toBe(30);
    expect(shownNumber(slider("20", "20.00"))).toBe(20);
    expect(shownNumber(slider("1", "1,250"))).toBe(1250);
    expect(shownNumber(slider("0", "Fri, 10:30 AM"))).toBeUndefined();
    expect(shownNumber(slider("10", "$10 SGD Minimum Price"))).toBeUndefined();
    expect(shownNumber(slider(""))).toBeUndefined();
  });
});

describe("whether a slider shows the value asked", () => {
  const asks = (state: SliderState, text: string) => shows(state, sliderTarget(text));

  it("reads a time of day where no digit runs into it (2:00 PM is not 12:00 PM)", () => {
    expect(asks(slider("7", "Fri, 02:00 PM"), "2:00 PM")).toBe(true);
    expect(asks(slider("7", "Fri, 02:00 PM"), "2:00pm")).toBe(true);
    expect(asks(slider("7", "Fri, 02:00 PM"), "Fri, 02:00 PM")).toBe(true);
    expect(asks(slider("3", "Fri, 12:00 PM"), "2:00 PM")).toBe(false);
    expect(asks(slider("7", "Fri, 02:00 PM"), "2:00 AM")).toBe(false);
    expect(asks(slider("7", "Fri, 02:00 PM"), "2")).toBe(false);
  });

  it("reads a number among words, not one that goes on in digits or a magnitude", () => {
    expect(asks(slider("500", "$500 SGD Minimum Price"), "$500")).toBe(true);
    expect(asks(slider("500", "$500 SGD Minimum Price"), "500")).toBe(true);
    expect(asks(slider("4", "8,000 subscribers"), "8000")).toBe(true);
    expect(asks(slider("4", "8,000 subscribers"), "8,000 subscribers")).toBe(true);
    expect(asks(slider("2", "500K, estimated cost $105.65"), "500K")).toBe(true);
    expect(asks(slider("2", "500K, estimated cost $105.65"), "500")).toBe(false);
    expect(asks(slider("1500", "$1500"), "500")).toBe(false);
    expect(asks(slider("30", "30.5 degrees"), "30")).toBe(false);
  });

  it("compares numbers as numbers when it shows a number alone", () => {
    expect(asks(slider("30.300000000000004"), "30.3")).toBe(true);
    expect(asks(slider("20", "20.00"), "20")).toBe(true);
    expect(asks(slider("20"), "$20")).toBe(true);
    expect(asks(slider("25"), "22")).toBe(false);
    expect(asks(slider("2"), "2:00 PM")).toBe(false);
    expect(asks(slider("100000"), "100K")).toBe(false);
  });

  it("shows nothing asked in no words", () => {
    expect(asks(slider("5", "five"), "")).toBe(false);
  });
});

describe("key presses toward a number", () => {
  it("close the gap at the step, at most the cap, none within half a step", () => {
    expect(pressesFor(10, 1, 50)).toBe(10);
    expect(pressesFor(-10, 2, 50)).toBe(5);
    expect(pressesFor(1000, 1, 50)).toBe(50);
    expect(pressesFor(0.4, 1, 50)).toBe(0);
    expect(pressesFor(0.6, 1, 50)).toBe(1);
    expect(pressesFor(3, 0, 50)).toBe(0);
  });
});

describe("a slider read from the page", () => {
  it("is its state, or nothing for no slider", () => {
    expect(
      readSlider({ native: false, value: "51", valueText: "51 years", vertical: true, disabled: true, focused: false }),
    ).toEqual({ native: false, value: "51", valueText: "51 years", vertical: true, disabled: true, focused: false });
    expect(
      readSlider({ native: true, value: "3", valueText: null, vertical: false, disabled: false, focused: true }),
    ).toEqual(slider("3"));
    expect(readSlider(null)).toBeUndefined();
    expect(readSlider(undefined)).toBeUndefined();
  });
});

describe("values a person would read the same", () => {
  const state = (value: string, valueText?: string): SliderState => ({
    native: true,
    value,
    valueText,
    vertical: false,
    disabled: false,
    focused: true,
  });
  const asks = (s: SliderState, text: string) => shows(s, sliderTarget(text));

  it("takes no hour for a number", () => {
    expect(sliderTarget("2 PM").number).toBeUndefined();
    expect(sliderTarget("10 am").number).toBeUndefined();
    expect(asks(state("2"), "2 PM")).toBe(false);
    expect(asks(state("14", "02:00 PM"), "2 PM")).toBe(true);
    expect(asks(state("14", "12:00 PM"), "2 PM")).toBe(false);
  });

  it("takes no thousands that read two ways for a number", () => {
    expect(sliderTarget("1 000").number).toBeUndefined();
    expect(sliderTarget("1.000 €").number).toBeUndefined();
    expect(sliderTarget("1,000").number).toBe(1000);
  });

  it("reads the minus sign number formats write", () => {
    expect(asks(state("-5", "\u22125 °C"), "5")).toBe(false);
    expect(asks(state("\u22125"), "5")).toBe(false);
    expect(asks(state("-5", "\u22125 °C"), "-5")).toBe(true);
  });

  it("reads empty decimals, a sign after letters, and spaced thousands", () => {
    expect(asks(state("20", "$20.00"), "$20")).toBe(true);
    expect(asks(state("500", "US$500"), "$500")).toBe(true);
    expect(asks(state("4", "8 000 abonnés"), "8000")).toBe(true);
    expect(asks(state("4", "8\u00a0000"), "8,000")).toBe(true);
    expect(asks(state("30", "30.5"), "30")).toBe(false);
  });

  it("reads words in a script written without spaces", () => {
    expect(asks(state("7", "周五下午2:00"), "下午2:00")).toBe(true);
    expect(asks(state("3", "周五下午12:00"), "下午2:00")).toBe(false);
  });
});
