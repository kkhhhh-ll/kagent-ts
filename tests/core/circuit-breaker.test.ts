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

  it("recordFailure transitions to HALF_OPEN on first failure", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    cb.recordFailure();
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    expect(cb.isAvailable).toBe(true); // HALF_OPEN is still available
    expect(cb.retriesRemaining).toBe(1);
  });

  it("opens circuit after all retries exhausted", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 1 });
    cb.recordFailure(); // 1st failure → HALF_OPEN, 0 retries remaining
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    expect(cb.isAvailable).toBe(true);
    expect(cb.retriesRemaining).toBe(0);
    cb.recordFailure(); // 2nd failure → OPEN
    expect(cb.state).toBe(BreakerState.OPEN);
    expect(cb.isAvailable).toBe(false);
    expect(cb.retriesRemaining).toBe(0);
  });

  it("recordSuccess from HALF_OPEN resets breaker back to CLOSED", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    cb.recordFailure(); // HALF_OPEN
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    cb.recordSuccess();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.retriesRemaining).toBe(2);
    expect(cb.currentFailureCount).toBe(0);
  });

  it("recordSuccess from OPEN enters HALF_OPEN (recovery probe), then second success closes", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 0 });
    cb.recordFailure(); // fails immediately → OPEN (threshold = 1)
    expect(cb.state).toBe(BreakerState.OPEN);

    // First success → HALF_OPEN (recovery probe)
    cb.recordSuccess();
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    expect(cb.isAvailable).toBe(true);
    expect(cb.currentFailureCount).toBe(0);

    // Second success → CLOSED (recovery confirmed)
    cb.recordSuccess();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.retriesRemaining).toBe(0); // retryCount=0
  });

  it("recordFailure from HALF_OPEN (recovery probe) goes back to OPEN", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 0 });
    cb.recordFailure(); // OPEN
    cb.recordSuccess(); // HALF_OPEN (recovery probe)
    expect(cb.state).toBe(BreakerState.HALF_OPEN);

    cb.recordFailure(); // recovery failed → back to OPEN
    expect(cb.state).toBe(BreakerState.OPEN);
    expect(cb.isAvailable).toBe(false);
  });

  it("recordSuccess from CLOSED state stays CLOSED", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    cb.recordSuccess();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.currentFailureCount).toBe(0);
  });

  it("getStatus returns correct snapshot including HALF_OPEN", () => {
    const cb = new CircuitBreaker({ toolName: "read_file", retryCount: 2 });
    cb.recordFailure();
    const status = cb.getStatus();
    expect(status.toolName).toBe("read_file");
    expect(status.state).toBe(BreakerState.HALF_OPEN);
    expect(status.failureCount).toBe(1);
    expect(status.failureThreshold).toBe(3);
    expect(status.available).toBe(true); // HALF_OPEN is available
  });

  it("reset() closes an open circuit", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 0 });
    cb.recordFailure(); // opens immediately (0 retries → threshold = 1)
    expect(cb.state).toBe(BreakerState.OPEN);
    cb.reset();
    expect(cb.state).toBe(BreakerState.CLOSED);
  });

  it("reset() from HALF_OPEN returns to CLOSED", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 2 });
    cb.recordFailure(); // HALF_OPEN
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    cb.reset();
    expect(cb.state).toBe(BreakerState.CLOSED);
    expect(cb.currentFailureCount).toBe(0);
  });

  it("stays HALF_OPEN with remaining retries after multiple failures within budget", () => {
    const cb = new CircuitBreaker({ toolName: "test_tool", retryCount: 3 });
    cb.recordFailure(); // failureCount=1, HALF_OPEN
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    cb.recordFailure(); // failureCount=2, still HALF_OPEN
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    cb.recordFailure(); // failureCount=3, still HALF_OPEN (equals retryCount, not >)
    expect(cb.state).toBe(BreakerState.HALF_OPEN);
    expect(cb.retriesRemaining).toBe(0);
    cb.recordFailure(); // failureCount=4 > retryCount=3 → OPEN
    expect(cb.state).toBe(BreakerState.OPEN);
  });
});
