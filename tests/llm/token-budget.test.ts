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
});
