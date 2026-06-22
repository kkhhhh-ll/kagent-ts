import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../../src/tools/circuit-breaker";
import { BreakerState } from "../../src/tools/types";

describe("CircuitBreaker", () => {
  it("starts CLOSED and available", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.isAvailable).toBe(true);
    expect(cb.retriesRemaining).toBe(2);
  });

  it("recordFailure decrements retries", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    cb.recordFailure();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.retriesRemaining).toBe(1);
  });

  it("opens circuit after all retries exhausted", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 1 });
    cb.recordFailure(); // 1st failure, 0 retries remaining
    expect(cb.state).toBe(BreakerState.CLOSED);
    cb.recordFailure(); // 2nd failure — opens
    expect(cb.state).toBe(BreakerState.OPEN);
    expect(cb.isAvailable).toBe(false);
    expect(cb.retriesRemaining).toBe(0);
  });

  it("recordSuccess resets breaker back to CLOSED", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 1 });
    cb.recordFailure(); // 1st failure
    cb.recordFailure(); // opens
    expect(cb.state).toBe(BreakerState.OPEN);
    cb.recordSuccess();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.retriesRemaining).toBe(1);
  });

  it("recordSuccess from CLOSED state stays CLOSED", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    cb.recordSuccess();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.currentFailureCount).toBe(0);
  });

  it("getStatus returns correct snapshot", () => {
    const cb = new CircuitBreaker({ toolName: "read_file", retryCount: 2 });
    cb.recordFailure();
    const status = cb.getStatus();
    expect(status.toolName).toBe("read_file");
    expect(status.state).toBe(BreakerState.CLOSED);
    expect(status.failureCount).toBe(1);
    expect(status.failureThreshold).toBe(3);
    expect(status.available).toBe(true);
  });

  it("reset() closes an open circuit", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 0 });
    cb.recordFailure(); // opens immediately (0 retries → threshold = 1)
    expect(cb.state).toBe(BreakerState.OPEN);
    cb.reset();
    expect(cb.state).toBe(BreakerState.CLOSED);
  });
});
