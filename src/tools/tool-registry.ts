import { Tool, BreakerStatus } from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { ToolErrorTracker } from "./error-tracker";

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

  /**
   * @param retryCount Number of retries allowed after the first failure
   *                    (default: 2 → 3 total attempts before circuit opens).
   * @param errorTracker Optional ToolErrorTracker for recording failure chains.
   */
  constructor(retryCount?: number, errorTracker?: ToolErrorTracker) {
    this.retryCount = retryCount ?? 2;
    this.errorTracker = errorTracker;
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

  // ─── Circuit Breaker ───────────────────────────────────────────────────

  /**
   * Execute a tool with circuit-breaker protection and retry guidance.
   *
   * - If the circuit is OPEN, returns an error message with a recommendation
   *   to try a different approach.
   * - If execution fails and retries remain, returns a message telling the LLM
   *   to analyze the error and retry with corrected parameters.
   * - If execution succeeds, records a success (resets failure count).
   *
   * @returns The tool's result string, or an error message with retry guidance.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return (
        `Error: Unknown tool "${name}". Available tools: ${this.toolNames.join(", ")}. ` +
        `Please check the tool name and try again.`
      );
    }

    const breaker = this.breakers.get(name)!;

    // Circuit breaker check — circuit is OPEN
    if (!breaker.isAvailable) {
      const status = breaker.getStatus();
      return (
        `Error: Tool "${name}" has been automatically disabled after ${status.failureCount} consecutive failures. ` +
        `It cannot be used again in this session. ` +
        `Please try a completely different approach that does not rely on this tool. ` +
        `Available alternatives: ${this.toolNames.filter((n) => n !== name).join(", ") || "none — try a different method."}`
      );
    }

    // Execute with failure tracking and retry guidance
    try {
      const result = await tool.execute(args);
      // Success after previous failures — record recovery + reset breaker
      if (breaker.currentFailureCount > 0) {
        // Record recovery in the error tracker
        if (this.errorTracker) {
          const activeTrace = this.errorTracker.getActiveTraceId(name);
          if (activeTrace) {
            this.errorTracker.recordRecovery(
              name,
              activeTrace,
              `Tool "${name}" executed successfully after ${breaker.currentFailureCount} failure(s).`
            );
          }
        }
        breaker.recordSuccess();
        return (
          `${result}\n\n` +
          `[Tool "${name}" has recovered after previous failures. The failure counter has been reset.]`
        );
      }
      breaker.recordSuccess();
      return result;
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const remaining = breaker.recordFailure();

      // Record the failure in the error tracker
      if (this.errorTracker) {
        this.errorTracker.recordFailure(name, args, rawMessage, remaining);
      }

      // Circuit just opened — no retries left
      if (!breaker.isAvailable) {
        return (
          `Error executing tool "${name}": ${rawMessage}\n\n` +
          `This was the final attempt. The tool "${name}" is now disabled after ${breaker.currentFailureCount} consecutive failures. ` +
          `Please do NOT try to use "${name}" again. Instead, try a different approach or a different tool.`
        );
      }

      // Retries still available — guide the LLM to re-analyze
      const attemptNum = breaker.currentFailureCount;
      const totalAllowed = breaker.effectiveThreshold;
      return (
        `Error executing tool "${name}": ${rawMessage}\n\n` +
        `[Retry Guidance] This is attempt ${attemptNum} of ${totalAllowed}. ` +
        `You have ${remaining} retry attempt${remaining > 1 ? "s" : ""} remaining.\n` +
        `Please analyze the error above carefully, correct the parameters, and retry. ` +
        `If you believe the issue is with the input, try a different approach or different arguments.`
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
