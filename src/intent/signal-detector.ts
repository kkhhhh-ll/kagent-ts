/**
 * User signal detection — unified, single-source regex / keyword matching
 * that replaces the duplicated patterns scattered across ReActAgent,
 * PlanSolveAgent, and FusionAgent.
 *
 * All signal detection happens once at the start of `Agent.run()`. Results
 * are stored on the agent and consumed by downstream logic (precipitation
 * trigger, memory reflection trigger, risky-plan confirmation, etc.).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Signals extracted from the user's input before the agent loop starts.
 *
 * Every field is a pure boolean computed from local string/regex matching
 * (zero LLM cost).  Downstream code reads these flags instead of running
 * its own ad-hoc regex.
 */
export interface UserSignals {
  /** User explicitly asked the agent to remember / save something. */
  wantsRemember: boolean;
  /** Input contains keywords associated with destructive / irreversible ops. */
  hasRiskyOps: boolean;
}

// ─── Patterns (single source of truth) ───────────────────────────────────────

const REMEMBER_PATTERN =
  /remember|save (this|it)|记住|保存|記住|儲存|记录下来/i;

const RISKY_KEYWORDS = [
  "deploy", "delete", "drop", "migrate", "truncate",
  "destroy", "purge", "reset", "format", "rm -rf",
  "force push", "hard reset",
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Build a single regex from the risky-keyword list (lazily cached). */
let _riskyRegex: RegExp | null = null;
function riskyRegex(): RegExp {
  if (!_riskyRegex) {
    _riskyRegex = new RegExp(
      RISKY_KEYWORDS.map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i",
    );
  }
  return _riskyRegex;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect user signals from the raw input string.
 *
 * Pure function — no side effects, no I/O.
 *
 * @example
 * ```ts
 * const signals = detectSignals("Please remember: always use pnpm");
 * signals.wantsRemember  // true
 * signals.hasRiskyOps    // false
 * ```
 */
export function detectSignals(input: string): UserSignals {
  return {
    wantsRemember: REMEMBER_PATTERN.test(input),
    hasRiskyOps: riskyRegex().test(input),
  };
}

/**
 * Check whether a plan text contains risky operations.
 *
 * Used by FusionAgent.planConfirmation: "auto" to decide whether the
 * user should review the plan before execution.
 */
export function planHasRiskyOps(planSteps: string[]): boolean {
  const text = planSteps.join(" ").toLowerCase();
  return RISKY_KEYWORDS.some((kw) => text.includes(kw));
}
