import { describe, expect, it } from "vitest";
import { chatUsage } from "./chat.ts";
import { answerValues, normalized, statedValues, unseenValues } from "./grounding.ts";

describe("an answer's values", () => {
  it("takes amounts, percentages, decimals and numbers of three digits or more", () => {
    expect(answerValues("$1,300/month, 25% off, 4.5 stars, 2 pets, 3 rooms, 85254, €12")).toEqual([
      "$1,300",
      "25%",
      "4.5",
      "85254",
      "€12",
    ]);
    expect(statedValues("$1,300/month, 25% off, 4.5 stars, 85254")).toEqual(["$1,300", "25%", "4.5"]);
  });

  it("finds a value in what was read whatever its separators or trailing zeros", () => {
    const read = normalized("Monthly pet rent $20/mo · Pet fee $350.00 · Rent from $1,299 · 15 % off");
    expect(unseenValues("rent $20, fee $350, from $1,299, 15% off", read)).toEqual([]);
    expect(unseenValues("fee $35 and $129", read)).toEqual(["$35", "$129"]);
  });

  it("checks the currency of a fee even if a page number or a time matches its digits", () => {
    const read = normalized("10 link Calendar · starts 10:30 · camping USD 36.00 · tickets €12 · tax 8 GBP");
    expect(unseenValues("fee $10, ticket $12, nightly €36", read)).toEqual(["$10", "$12", "€36"]);
    expect(unseenValues("camping $36, ticket EUR 12, tax £8", read)).toEqual([]);
    expect(unseenValues("fee $3, nightly $360", read)).toEqual(["$3", "$360"]);
  });
});

describe("a chat answer's usage", () => {
  it("counts Vertex AI's reasoning tokens as output, and OpenAI's as they are", () => {
    expect(
      chatUsage({
        prompt_tokens: 14,
        completion_tokens: 37,
        total_tokens: 474,
        completion_tokens_details: { reasoning_tokens: 423 },
      }),
    ).toEqual({ input: 14, output: 460 });
    expect(
      chatUsage({
        prompt_tokens: 10,
        completion_tokens: 50,
        total_tokens: 60,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({
      input: 10,
      output: 50,
      cached: 4,
    });
  });
});
