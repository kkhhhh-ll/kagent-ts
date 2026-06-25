import { describe, it, expect, beforeEach } from "vitest";
import { ToolCallEvaluator } from "../../src/eval/tool-call-evaluator";
import { ToolErrorCode } from "../../src/tools/types";

describe("ToolCallEvaluator", () => {
  let evaluator: ToolCallEvaluator;

  beforeEach(() => {
    evaluator = new ToolCallEvaluator();
  });

  // ── Record keeping ─────────────────────────────────────────────────

  describe("record keeping", () => {
    it("records a successful tool call (start → end)", () => {
      evaluator.onToolStart("read_file", { path: "/tmp/a.txt" }, "call_1");
      evaluator.onToolEnd("read_file", "file contents here", "call_1");

      const records = evaluator.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].toolName).toBe("read_file");
      expect(records[0].args).toEqual({ path: "/tmp/a.txt" });
      expect(records[0].success).toBe(true);
      expect(records[0].errorCode).toBe(ToolErrorCode.SUCCESS);
      expect(records[0].resultLength).toBe(18);
      expect(records[0].startTime).toBeTruthy();
      expect(records[0].endTime).toBeTruthy();
      expect(records[0].latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("records a failed tool call (start → error)", () => {
      evaluator.onToolStart("bash", { command: "rm -rf /" }, "call_2");
      evaluator.onToolError(
        "bash",
        "[RETRYABLE:EXECUTION_FAILURE] Permission denied",
        "call_2",
      );

      const records = evaluator.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].toolName).toBe("bash");
      expect(records[0].success).toBe(false);
      expect(records[0].error).toContain("Permission denied");
      expect(records[0].errorCode).toBe(ToolErrorCode.EXECUTION_FAILURE);
    });

    it("records a circuit-breaker open event", () => {
      evaluator.onToolStart("dangerous_tool", {}, "call_3");
      evaluator.onToolError(
        "dangerous_tool",
        "[FATAL:CIRCUIT_OPEN] Circuit breaker is open",
        "call_3",
      );

      const records = evaluator.getRecords();
      expect(records[0].errorCode).toBe(ToolErrorCode.CIRCUIT_OPEN);
    });

    it("defaults error code when message is not structured", () => {
      evaluator.onToolStart("bad_tool", {}, "call_4");
      evaluator.onToolError("bad_tool", "Something went wrong!", "call_4");

      expect(evaluator.getRecords()[0].errorCode).toBe(
        ToolErrorCode.EXECUTION_FAILURE,
      );
    });

    it("tracks attempt numbers correctly across multiple calls", () => {
      // First attempt fails
      evaluator.onToolStart("flaky", {}, "call_1");
      evaluator.onToolError("flaky", "[RETRYABLE:EXECUTION_FAILURE] fail1", "call_1");

      // Second attempt succeeds
      evaluator.onToolStart("flaky", {}, "call_2");
      evaluator.onToolEnd("flaky", "ok", "call_2");

      expect(evaluator.getRecords()[0].attemptNumber).toBe(1);
      expect(evaluator.getRecords()[1].attemptNumber).toBe(2);
    });
  });

  // ── ID-based record matching ──────────────────────────────────────

  describe("record matching by ID", () => {
    it("matches end/error to the correct record via toolCallId", () => {
      // Same tool, two parallel calls — verify ID disambiguation
      evaluator.onToolStart("bash", { command: "echo a" }, "id_a");
      evaluator.onToolStart("bash", { command: "echo b" }, "id_b");
      evaluator.onToolEnd("bash", "a", "id_a");
      evaluator.onToolEnd("bash", "b", "id_b");

      const records = evaluator.getRecords();
      expect(records[0].resultLength).toBe(1);
      expect(records[1].resultLength).toBe(1);
      expect(records[0].args).toEqual({ command: "echo a" });
      expect(records[1].args).toEqual({ command: "echo b" });
    });

    it("falls back to name-based matching when no ID is provided", () => {
      evaluator.onToolStart("read_file", { path: "a" });
      evaluator.onToolEnd("read_file", "content");

      expect(evaluator.getRecords()[0].success).toBe(true);
    });
  });

  // ── Scorecard ─────────────────────────────────────────────────────

  describe("getScorecard", () => {
    it("returns an empty scorecard when no calls were recorded", () => {
      const sc = evaluator.getScorecard();
      expect(sc.totalCalls).toBe(0);
      expect(sc.overallSuccessRate).toBe(1);
      expect(sc.uniqueToolsUsed).toBe(0);
    });

    it("computes correct success rate", () => {
      evaluator.onToolStart("a", {}, "1");
      evaluator.onToolEnd("a", "ok", "1");

      evaluator.onToolStart("a", {}, "2");
      evaluator.onToolError("a", "[RETRYABLE:EXECUTION_FAILURE] x", "2");

      const sc = evaluator.getScorecard();
      expect(sc.totalCalls).toBe(2);
      expect(sc.totalSuccesses).toBe(1);
      expect(sc.totalFailures).toBe(1);
      expect(sc.overallSuccessRate).toBeCloseTo(0.5);
    });

    it("counts unique tools correctly", () => {
      evaluator.onToolStart("read_file", {}, "1");
      evaluator.onToolEnd("read_file", "ok", "1");
      evaluator.onToolStart("bash", {}, "2");
      evaluator.onToolEnd("bash", "ok", "2");
      evaluator.onToolStart("read_file", {}, "3");
      evaluator.onToolEnd("read_file", "ok", "3");

      const sc = evaluator.getScorecard();
      expect(sc.uniqueToolsUsed).toBe(2);
    });

    it("includes circuit breaker trip counts", () => {
      evaluator.onToolStart("risky", {}, "1");
      evaluator.onToolError("risky", "[FATAL:CIRCUIT_OPEN] open", "1");

      evaluator.onToolStart("risky", {}, "2");
      evaluator.onToolError("risky", "[FATAL:CIRCUIT_OPEN] open again", "2");

      const sc = evaluator.getScorecard();
      expect(sc.circuitBreakerTrips).toBe(2);

      const risky = sc.perTool.find((t) => t.toolName === "risky");
      expect(risky?.circuitBreakerTrips).toBe(2);
    });
  });

  // ── Report ────────────────────────────────────────────────────────

  describe("generateReport", () => {
    it("returns a placeholder when no calls were made", () => {
      const report = evaluator.generateReport();
      expect(report).toContain("No tool calls recorded");
    });

    it("generates a markdown report with summary and per-tool breakdown", () => {
      evaluator.onToolStart("read_file", {}, "1");
      evaluator.onToolEnd("read_file", "contents", "1");

      const report = evaluator.generateReport();
      expect(report).toContain("# Tool Call Evaluation Report");
      expect(report).toContain("## Summary");
      expect(report).toContain("## Per-Tool Breakdown");
      expect(report).toContain("## Error Distribution");
      expect(report).toContain("`read_file`");
      expect(report).toContain("100.0%");
    });
  });

  // ── Reset ─────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all records and counters", () => {
      evaluator.onToolStart("bash", {}, "1");
      evaluator.onToolEnd("bash", "ok", "1");

      evaluator.reset();

      expect(evaluator.getRecords()).toHaveLength(0);
      expect(evaluator.getScorecard().totalCalls).toBe(0);
    });
  });
});
