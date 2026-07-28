import { describe, expect, it } from "vitest";
import { latestLegacyPlan, normalizePlanEntries } from "../src/plans";

describe("normalizePlanEntries", () => {
  it("keeps valid ACP plan entries and rejects malformed values", () => {
    expect(
      normalizePlanEntries([
        { content: "Inspect", priority: "high", status: "completed" },
        { content: "Implement", priority: "medium", status: "in_progress" },
        { content: "Verify", priority: "low", status: "pending" },
        { content: "", priority: "low", status: "pending" },
        { content: "Bad priority", priority: "urgent", status: "pending" },
        { content: "Bad status", priority: "low", status: "blocked" },
        null,
      ]),
    ).toEqual([
      { content: "Inspect", priority: "high", status: "completed" },
      { content: "Implement", priority: "medium", status: "in_progress" },
      { content: "Verify", priority: "low", status: "pending" },
    ]);
  });

  it("returns an empty plan for non-array input", () => {
    expect(normalizePlanEntries(undefined)).toEqual([]);
    expect(normalizePlanEntries({ entries: [] })).toEqual([]);
  });
});

describe("latestLegacyPlan", () => {
  it("returns the newest valid legacy plan", () => {
    expect(
      latestLegacyPlan([
        {
          kind: "plan",
          plan: [{ content: "Old", priority: "low", status: "completed" }],
        },
        { kind: "assistant", text: "not a plan" },
        {
          kind: "plan",
          plan: [{ content: "Current", priority: "high", status: "in_progress" }],
        },
      ]),
    ).toEqual([{ content: "Current", priority: "high", status: "in_progress" }]);
  });

  it("ignores empty, invalid, and non-array transcript values", () => {
    expect(latestLegacyPlan([])).toBeUndefined();
    expect(latestLegacyPlan([{ kind: "plan", plan: [] }])).toEqual([]);
    expect(latestLegacyPlan([{ kind: "plan", plan: [{ content: "bad" }] }])).toEqual([]);
  });
});
