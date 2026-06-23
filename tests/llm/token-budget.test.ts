import { describe, it, expect } from "vitest";
import { TokenBudget } from "../../src/llm/token-budget";

describe("TokenBudget", () => {
  it("starts with full budget", () => {
    const budget = new TokenBudget({ maxTotalTokens: 10000 });
    const status = budget.getStatus();
    expect(status.isExhausted).toBe(false);
    expect(status.remainingTokens).toBe(10000);
    expect(status.totalTokensUsed).toBe(0);
    expect(status.callCount).toBe(0);
  });

  it("records usage correctly", () => {
    const budget = new TokenBudget({ maxTotalTokens: 10000 });
    budget.recordUsage(500, 300);
    const status = budget.getStatus();
    expect(status.totalTokensUsed).toBe(800);
    expect(status.remainingTokens).toBe(9200);
    expect(status.callCount).toBe(1);
    expect(status.isExhausted).toBe(false);
  });

  it("exhausts budget when cumulative usage reaches limit", () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });
    budget.recordUsage(600, 400); // 1000 total
    const status = budget.getStatus();
    expect(status.isExhausted).toBe(true);
    expect(status.remainingTokens).toBe(0);
  });

  it("checkBeforeCall accounts for estimated input", () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });
    budget.recordUsage(500, 100); // 600 used

    // 300 estimated input + 600 used = 900, still under 1000
    const ok = budget.checkBeforeCall(300);
    expect(ok.isExhausted).toBe(false);
    expect(ok.remainingTokens).toBe(100);

    // 500 estimated would exceed
    const exhausted = budget.checkBeforeCall(500);
    expect(exhausted.isExhausted).toBe(true);
    expect(exhausted.remainingTokens).toBe(0);
  });

  it("checkBeforeCall does not permanently modify the budget", () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });
    budget.checkBeforeCall(900); // projected exceeds
    // Budget should still show original usage
    expect(budget.getStatus().totalTokensUsed).toBe(0);
  });

  it("reset clears all state", () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });
    budget.recordUsage(400, 200);
    budget.reset();
    const status = budget.getStatus();
    expect(status.totalTokensUsed).toBe(0);
    expect(status.callCount).toBe(0);
    expect(status.isExhausted).toBe(false);
  });

  it("shouldWarn fires once at warnThreshold", () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000, warnThreshold: 0.5 });
    expect(budget.shouldWarn()).toBe(false);
    budget.recordUsage(300, 250); // 550 > 500
    expect(budget.shouldWarn()).toBe(true);
    expect(budget.shouldWarn()).toBe(false); // second call returns false
  });

  it("getSessionCost returns zero when no pricing configured", () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });
    budget.recordUsage(500, 300);
    const cost = budget.getSessionCost();
    expect(cost.inputTokens).toBe(500);
    expect(cost.outputTokens).toBe(300);
    expect(cost.totalTokens).toBe(800);
    expect(cost.totalCost).toBe(0);
  });

  it("getSessionCost calculates correctly with pricing", () => {
    const budget = new TokenBudget({
      maxTotalTokens: 10000,
      pricing: { inputPricePer1K: 0.0025, outputPricePer1K: 0.01 },
    });
    budget.recordUsage(2000, 1000); // 2K input, 1K output
    const cost = budget.getSessionCost();
    expect(cost.inputTokens).toBe(2000);
    expect(cost.outputTokens).toBe(1000);
    expect(cost.inputCost).toBeCloseTo(0.005, 4);  // 2 * 0.0025
    expect(cost.outputCost).toBeCloseTo(0.01, 4);  // 1 * 0.01
    expect(cost.totalCost).toBeCloseTo(0.015, 4);
  });

  it("reset clears cost tracking", () => {
    const budget = new TokenBudget({
      maxTotalTokens: 1000,
      pricing: { inputPricePer1K: 0.01, outputPricePer1K: 0.02 },
    });
    budget.recordUsage(100, 200);
    expect(budget.getSessionCost().totalCost).toBeGreaterThan(0);
    budget.reset();
    expect(budget.getSessionCost().totalCost).toBe(0);
  });
});
