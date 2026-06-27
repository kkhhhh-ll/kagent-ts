import { Tool, ToolResult, ToolErrorCode, toolSuccess, toolError, BreakerStatus } from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { ToolErrorTracker } from "./error-tracker";
import { ToolOutputTruncator } from "./tool-output-truncator";
import { ToolFilter } from "./tool-filter";

/**
 * Registry that manages tool definitions together with circuit breakers.
 *
 * Provides:
 * - Tool registration and lookup
 * - Safe execution with circuit breaker protection
 * - Per-tool failure tracking with retry guidance
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private breakers: Map<string, CircuitBreaker> = new Map();
  private retryCount: number;
  private errorTracker?: ToolErrorTracker;
  private truncator: ToolOutputTruncator;

  /**
   * @param retryCount Number of retries allowed after the first failure
   *                    (default: 2 → 3 total attempts before circuit opens).
   * @param errorTracker Optional ToolErrorTracker for recording failure chains.
   * @param truncator   Optional ToolOutputTruncator for truncating large
   *                    tool outputs (default: enabled with default limits).
   */
  constructor(
    retryCount?: number,
    errorTracker?: ToolErrorTracker,
    truncator?: ToolOutputTruncator,
  ) {
    this.retryCount = retryCount ?? 2;
    this.errorTracker = errorTracker;
    this.truncator = truncator ?? new ToolOutputTruncator();
  }

  /**
   * Register a tool. Creates a circuit breaker for it automatically.
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
    this.breakers.set(
      tool.name,
      new CircuitBreaker({
        toolName: tool.name,
        retryCount: this.retryCount,
      })
    );
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by name. Returns undefined if not found.
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools (for passing to the LLM).
   */
  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Remove a tool and its circuit breaker.
   */
  remove(name: string): boolean {
    this.breakers.delete(name);
    return this.tools.delete(name);
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the number of registered tools.
   */
  get count(): number {
    return this.tools.size;
  }

  /**
   * Get all registered tool names.
   */
  get toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  // ─── Tool Filter ───────────────────────────────────────────────────────

  /**
   * Create a new ToolRegistry containing only tools that pass the given
   * filter. Circuit breaker state is NOT copied — each filtered registry
   * starts fresh (appropriate for sub-agents).
   *
   * @param filter The filter to apply.
   * @returns A new ToolRegistry with the filtered tool set.
   */
  filter(filter: ToolFilter): ToolRegistry {
    const registry = new ToolRegistry(
      this.retryCount,
      this.errorTracker,
      this.truncator,
    );
    for (const tool of this.tools.values()) {
      if (filter.filter(tool)) {
        registry.register(tool);
      }
    }
    return registry;
  }

  // ─── Circuit Breaker ───────────────────────────────────────────────────

  /**
   * Execute a tool with circuit-breaker protection and retry guidance.
   *
   * Returns a structured {@link ToolResult} with a machine-readable
   * {@link ToolErrorCode} so callers can react precisely.
   *
   * Possible error codes:
   * - `SUCCESS`            — tool completed normally.
   * - `UNKNOWN_TOOL`       — tool name not registered.
   * - `CIRCUIT_OPEN`       — tool is disabled (too many failures).
   * - `EXECUTION_FAILURE`  — tool threw an exception; retries may remain.
   * - `TRUNCATED_OUTPUT`   — tool output was truncated.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return toolError(
        ToolErrorCode.UNKNOWN_TOOL,
        `[FATAL:UNKNOWN_TOOL] The tool "${name}" is not registered. ` +
        `Available tools: ${this.toolNames.join(", ")}. ` +
        `Please use one of the available tools instead.`,
        "fatal",
      );
    }

    const breaker = this.breakers.get(name)!;

    // Circuit breaker check — circuit is OPEN
    if (!breaker.isAvailable) {
      const status = breaker.getStatus();
      return toolError(
        ToolErrorCode.CIRCUIT_OPEN,
        `[FATAL:CIRCUIT_OPEN] Tool "${name}" has been disabled after ${status.failureCount} consecutive failures. ` +
        `It cannot be used again in this session. ` +
        `Please find a completely different approach. ` +
        `Available alternatives: ${this.toolNames.filter((n) => n !== name).join(", ") || "none — try a different method."}`,
        "fatal",
      );
    }

    // Execute with failure tracking and retry guidance
    try {
      const rawResult = await tool.execute(args);
      const truncated = this.truncator.truncate(name, rawResult);
      const wasTruncated = truncated !== rawResult;

      // Success after previous failures — record recovery + reset breaker.
      // Only include the recovery message in the LLM context when an
      // error tracker is active (meaning the LLM was previously informed
      // of the failures via error-analysis injection).
      if (breaker.currentFailureCount > 0) {
        let hadActiveTrace = false;
        if (this.errorTracker) {
          const activeTrace = this.errorTracker.getActiveTraceId(name);
          if (activeTrace) {
            this.errorTracker.recordRecovery(
              name,
              activeTrace,
              `Tool "${name}" executed successfully after ${breaker.currentFailureCount} failure(s).`
            );
            hadActiveTrace = true;
          }
        }
        breaker.recordSuccess();

        if (hadActiveTrace) {
          const content = wasTruncated
            ? `${truncated}\n\n[Tool "${name}" has recovered after previous failures. The failure counter has been reset.]\n[Note: Output was truncated due to size limits.]`
            : `${truncated}\n\n[Tool "${name}" has recovered after previous failures. The failure counter has been reset.]`;
          return {
            success: true,
            severity: "success",
            errorCode: wasTruncated ? ToolErrorCode.TRUNCATED_OUTPUT : ToolErrorCode.SUCCESS,
            content,
          };
        }

        // Breaker was reset but no active error trace — silent recovery.
        return toolSuccess(truncated);
      }

      breaker.recordSuccess();
      return toolSuccess(truncated);
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const remaining = breaker.recordFailure();

      // Record the failure in the error tracker
      if (this.errorTracker) {
        this.errorTracker.recordFailure(name, args, rawMessage, remaining, breaker.state);
      }

      // Circuit just opened — no retries left
      if (!breaker.isAvailable) {
        return toolError(
          ToolErrorCode.EXECUTION_FAILURE,
          `[FATAL:EXECUTION_FAILURE] Tool "${name}" threw an exception: ${rawMessage}\n\n` +
          `This was the final attempt. The tool is now disabled after ${breaker.currentFailureCount} consecutive failures. ` +
          `Do NOT retry "${name}". Find a different approach or tool.`,
          "fatal",
        );
      }

      // Retries still available — circuit is HALF_OPEN (degraded)
      const attemptNum = breaker.currentFailureCount;
      const totalAllowed = breaker.effectiveThreshold;
      const stateWarning =
        remaining === 0
          ? `\n⚠️  The circuit breaker for "${name}" is now in a degraded state (HALF_OPEN). ` +
            `The NEXT failure will permanently disable this tool. Proceed with extreme caution.`
          : `\n⚠️  The circuit breaker for "${name}" is now in a degraded state (HALF_OPEN). ` +
            `After ${remaining} more failure(s), the tool will be permanently disabled.`;
      return toolError(
        ToolErrorCode.EXECUTION_FAILURE,
        `[RETRYABLE:EXECUTION_FAILURE] Tool "${name}" threw an exception: ${rawMessage}\n\n` +
        `This is attempt ${attemptNum} of ${totalAllowed}. ` +
        `You have ${remaining} retry attempt${remaining > 1 ? "s" : ""} remaining.${stateWarning}\n` +
        `Analyze the error, correct the parameters, and retry. ` +
        `If the approach is fundamentally wrong, try a different method.`,
        "retryable",
      );
    }
  }

  /**
   * Get the error tracker instance, if one is configured.
   */
  getErrorTracker(): ToolErrorTracker | undefined {
    return this.errorTracker;
  }

  /**
   * Get the circuit breaker status for a tool.
   */
  getBreakerStatus(name: string): BreakerStatus | undefined {
    return this.breakers.get(name)?.getStatus();
  }

  /**
   * Get status for all tools.
   */
  getAllBreakerStatuses(): BreakerStatus[] {
    return Array.from(this.breakers.values()).map((b) => b.getStatus());
  }

  /**
   * Manually reset the circuit breaker for a specific tool.
   */
  resetBreaker(name: string): void {
    this.breakers.get(name)?.reset();
  }

  /**
   * Reset all circuit breakers.
   */
  resetAllBreakers(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
