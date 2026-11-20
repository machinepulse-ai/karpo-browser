import { expect, it } from "vitest";
import { controllerModel } from "./models.ts";

it("takes a name the table inherits for a model id, not for a preset", () => {
  expect(controllerModel("constructor")).toEqual({ model: "constructor" });
});
