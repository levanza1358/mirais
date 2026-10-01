import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_MODELS, antigravityModelCatalog } from "../src/proxy/antigravity";

describe("Antigravity catalog", () => {
  test("contains the supported Cloud Code models with metadata", () => {
    expect(ANTIGRAVITY_MODELS.map((model) => model.id)).toEqual([
      "gemini-3-pro-high",
      "claude-sonnet-4-5",
      "claude-opus-4-5-thinking",
    ]);
    expect(antigravityModelCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gemini-3-pro-high", contextLength: 1_048_576 }),
      expect.objectContaining({ id: "claude-sonnet-4-5", maxOutputTokens: 64_000 }),
    ]));
  });
});
