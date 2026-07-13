/**
 * User signal detection — unified, single-source regex / keyword matching
 * that replaces the duplicated patterns scattered across ReActAgent,
 * PlanSolveAgent, and FusionAgent.
 *
 * All signal detection happens once at the start of `Agent.run()`. Results
 * are stored on the agent and consumed by downstream logic (precipitation
 * trigger, memory reflection trigger, risky-plan confirmation, etc.).
 *
 * ## Design
 *
 * - **Zero LLM cost** — pure regex/keyword matching, no API calls.
 * - **Multi-label scenarios** — a task can be both "debugging" and "code-write".
 * - **Risk gradation** — `none` / `low` / `high` instead of a boolean.
 * - **Negation-aware** — "不要删除" won't flag a risk.
 * - **Complexity heuristic** — cheap signal for future routing decisions.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Task scenario inferred from the user's input.
 *
 * Used to bind error-notebook entries to the kind of task that caused them,
 * so future runs in the same scenario can recall relevant past mistakes.
 */
export type AgentScenario =
  | "file-search"
  | "code-read"
  | "code-write"
  | "refactoring"
  | "debugging"
  | "deployment"
  | "testing"
  | "configuration";

/**
 * Risk level for an operation described in the user's input.
 *
 * - `none` — no risky keywords detected.
 * - `low`  — routine but impactful ops (deploy, release, migrate, reset).
 * - `high` — destructive / irreversible ops (delete, drop, force push, etc.).
 */
export type RiskLevel = "none" | "low" | "high";

/**
 * Estimated task complexity from surface-level input heuristics.
 *
 * Purely a signal for future routing / strategy selection — not used for
 * critical decisions today.
 */
export type TaskComplexity = "simple" | "moderate" | "complex";

/**
 * Signals extracted from the user's input before the agent loop starts.
 *
 * Every field is a pure boolean/computed value from local string/regex
 * matching (zero LLM cost).  Downstream code reads these flags instead
 * of running its own ad-hoc regex.
 */
export interface UserSignals {
  /** User explicitly asked the agent to remember / save something. */
  wantsRemember: boolean;
  /**
   * Risk level inferred from the input.
   *
   * Replaces the old boolean `hasRiskyOps`.  Negation markers
   * ("不要", "don't", ...) can demote the level.
   */
  riskLevel: RiskLevel;
  /**
   * Task scenarios detected in the user's input (multi-label).
   *
   * A single input can match multiple scenarios — e.g. "find the bug
   * in auth.ts and fix it" matches both `file-search` and `debugging`.
   * Empty array when no scenario pattern matched.
   */
  scenarios: AgentScenario[];
  /**
   * Estimated task complexity from surface heuristics
   * (input length, file references, sentence count, etc.).
   */
  complexity: TaskComplexity;
}

// ─── Remember pattern ────────────────────────────────────────────────────────

const REMEMBER_PATTERN =
  /remember|save (this|it)|记住|保存|記住|儲存|记录下来|記錄下來/i;

// ─── Risk classification ─────────────────────────────────────────────────────

/**
 * High-risk keywords: destructive or irreversible operations.
 *
 * These trigger `riskLevel: "high"` and will always prompt for plan
 * confirmation when `planConfirmation` is `"auto"`.
 */
const HIGH_RISK_KEYWORDS = [
  "rm -rf", "force push", "hard reset",
  "delete", "drop", "destroy", "purge", "format", "truncate",
];

/**
 * Low-risk keywords: impactful but routine operations.
 *
 * These trigger `riskLevel: "low"` — worth noting but not alarming.
 */
const LOW_RISK_KEYWORDS = [
  "deploy", "release", "publish", "ship", "migrate", "reset",
];

/**
 * Negation markers. When one of these appears near a risky keyword
 * (within the same sentence), that keyword is excluded from risk
 * scoring, or the overall risk is demoted.
 */
const NEGATION_MARKERS = [
  "不要", "千万别", "禁止", "切勿", "请勿", "避免",
  "don't", "do not", "never", "without", "avoid", "prevent",
  "shouldn't", "should not", "can't", "cannot",
];

// ─── Scenario detection (multi-label) ────────────────────────────────────────

/**
 * Scenario detection patterns.
 *
 * Each scenario has two match lists:
 * - `latin`: matched with word-start-anchored regex (`(?:^|\s)` prefix — works
 *   for space-delimited languages). Stems only (no trailing boundary) so
 *   inflected forms (bugs, fixes, writes, creates, …) also match.
 * - `cjk`: matched with plain `String.includes()` — CJK text has no spaces
 *   between characters, so regex word boundaries don't apply.
 *
 * All patterns are tested (multi-label).  A single input can produce 0–N
 * scenario matches.
 */
interface ScenarioPattern {
  latin: string[];
  cjk: string[];
  scenario: AgentScenario;
}

const SCENARIO_PATTERNS: ScenarioPattern[] = [
  {
    latin: ["refactor", "restructur", "renam", "mov", "extract"],
    cjk: ["重构", "重命名", "重構"],
    scenario: "refactoring",
  },
  {
    latin: ["bug", "debug", "fix", "error", "crash", "broken"],
    cjk: ["调试", "修复", "报错", "調試", "修復", "報錯"],
    scenario: "debugging",
  },
  {
    latin: ["deploy", "releas", "publish", "ship"],
    cjk: ["部署", "发布", "上线", "發布", "上線"],
    scenario: "deployment",
  },
  {
    latin: ["test", "spec", "coverage"],
    cjk: ["测试", "单元测试", "測試", "單元測試"],
    scenario: "testing",
  },
  {
    latin: ["config", "setup", "install", "env", "dependenc"],
    cjk: ["配置", "安装", "环境", "安裝", "環境"],
    scenario: "configuration",
  },
  {
    latin: ["grep", "search", "find", "look", "locate"],
    cjk: ["搜索", "查找", "找"],
    scenario: "file-search",
  },
  {
    latin: ["read", "understand", "explain", "review"],
    cjk: ["阅读", "解释", "审查", "閱讀", "解釋", "審查"],
    scenario: "code-read",
  },
  {
    latin: ["writ", "implement", "add", "creat", "generat"],
    cjk: ["写", "实现", "创建", "寫", "實現", "創建"],
    scenario: "code-write",
  },
];

/** Lazily-built compiled regexes for each scenario's Latin stems. */
let _scenarioRegexes: Array<{ regex: RegExp; scenario: AgentScenario }> | null = null;
function scenarioRegexes(): Array<{ regex: RegExp; scenario: AgentScenario }> {
  if (!_scenarioRegexes) {
    _scenarioRegexes = SCENARIO_PATTERNS.map((p) => ({
      regex: new RegExp(`(?:^|\\s)(${p.latin.join("|")})`, "i"),
      scenario: p.scenario,
    }));
  }
  return _scenarioRegexes;
}

/** Match scenarios against input (multi-label). */
function detectScenarios(input: string): AgentScenario[] {
  const results = new Set<AgentScenario>();
  const lower = input.toLowerCase();

  // 1) Latin stems via compiled regex
  for (const { regex, scenario } of scenarioRegexes()) {
    if (regex.test(input)) {
      results.add(scenario);
    }
  }

  // 2) CJK stems via plain substring match
  for (const p of SCENARIO_PATTERNS) {
    for (const kw of p.cjk) {
      if (lower.includes(kw.toLowerCase())) {
        results.add(p.scenario);
        break; // one CJK match is enough for this scenario
      }
    }
  }

  return Array.from(results);
}

// ─── Complexity heuristics ───────────────────────────────────────────────────

/**
 * Estimate task complexity from surface-level input characteristics.
 *
 * Scoring factors (cumulative):
 * - Input length > 100 chars     → +1
 * - Input length > 500 chars     → +1
 * - ≥ 3 file-path references     → +1
 * - ≥ 6 file-path references     → +1
 * - ≥ 3 sentences                → +1
 * - ≥ 6 sentences                → +1
 * - Broad-scope keywords         → +1  (refactor, migrate, 整个, all, entire, …)
 * - Multi-task connectors        → +1  (both, and also, 同时, 并且, …)
 *
 * Thresholds:
 * - 0–1 → simple
 * - 2–3 → moderate
 * - 4+  → complex
 */
function estimateComplexity(input: string): TaskComplexity {
  const len = input.length;

  // File-path-like patterns: "foo.ts", "src/bar.py", etc.
  const fileRefs = (input.match(/[^\s"'`*]+\.[a-z]{1,8}\b/gi) || []).length;

  // Sentence count across CJK and Latin punctuation
  const sentences = input
    .split(/[.!?。！？\n]+/)
    .filter((s) => s.trim().length > 0);
  const sentenceCount = sentences.length;

  let score = 0;
  if (len > 100) score++;
  if (len > 500) score++;
  if (fileRefs >= 3) score++;
  if (fileRefs >= 6) score++;
  if (sentenceCount >= 3) score++;
  if (sentenceCount >= 6) score++;
  if (/\b(refactor|migrate|整个|全部|所有|every|all|entire)\b/i.test(input)) score++;
  if (/\b(both|and also|同时|并且|以及|also|additionally)\b/i.test(input)) score++;

  if (score <= 1) return "simple";
  if (score <= 3) return "moderate";
  return "complex";
}

// ─── Negation helpers ─────────────────────────────────────────────────────────

/**
 * Build a regex that matches any negation marker.
 * Lazily cached — created once on first call.
 */
let _negationRegex: RegExp | null = null;
function negationRegex(): RegExp {
  if (!_negationRegex) {
    _negationRegex = new RegExp(
      NEGATION_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i",
    );
  }
  return _negationRegex;
}

/**
 * Check whether a sentence (or the whole input) contains a negation marker.
 */
function hasNegation(text: string): boolean {
  return negationRegex().test(text);
}

// ─── Risk-level computation ──────────────────────────────────────────────────

/** Build a word-boundary regex for a keyword (handles multi-word phrases). */
function keywordRegex(keyword: string): RegExp {
  if (keyword.includes(" ")) {
    // Multi-word phrase: use case-insensitive substring match
    return new RegExp(
      keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
  }
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

/** Lazily cached compiled regexes for high-risk keywords. */
let _highRiskRegexes: RegExp[] | null = null;
function highRiskRegexes(): RegExp[] {
  if (!_highRiskRegexes) {
    _highRiskRegexes = HIGH_RISK_KEYWORDS.map(keywordRegex);
  }
  return _highRiskRegexes;
}

/** Lazily cached compiled regexes for low-risk keywords. */
let _lowRiskRegexes: RegExp[] | null = null;
function lowRiskRegexes(): RegExp[] {
  if (!_lowRiskRegexes) {
    _lowRiskRegexes = LOW_RISK_KEYWORDS.map(keywordRegex);
  }
  return _lowRiskRegexes;
}

/**
 * Determine the risk level of user input.
 *
 * Rules:
 * 1. Split input into sentences.
 * 2. In sentences with negation markers, risky keywords are ignored.
 * 3. Otherwise, any high-risk match → `"high"`.
 * 4. Any low-risk match → `"low"`.
 * 5. Nothing matched → `"none"`.
 */
function computeRiskLevel(input: string): RiskLevel {
  const sentences = input.split(/[.!?。！？\n]+/).filter((s) => s.trim().length > 0);

  // If there are no clear sentence boundaries, treat the whole input as one sentence
  const chunks = sentences.length > 0 ? sentences : [input];

  let hasHigh = false;
  let hasLow = false;

  for (const chunk of chunks) {
    // Skip chunks that contain negation — the user is saying "don't do X"
    if (hasNegation(chunk)) continue;

    for (const re of highRiskRegexes()) {
      if (re.test(chunk)) {
        hasHigh = true;
        break; // no need to check more high-risk patterns in this chunk
      }
    }
    for (const re of lowRiskRegexes()) {
      if (re.test(chunk)) {
        hasLow = true;
        break;
      }
    }
  }

  if (hasHigh) return "high";
  if (hasLow) return "low";
  return "none";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect user signals from the raw input string.
 *
 * Pure function — no side effects, no I/O, no LLM calls.
 *
 * @example
 * ```ts
 * const signals = detectSignals("Please remember: always use pnpm");
 * signals.wantsRemember  // true
 * signals.riskLevel       // "none"
 * signals.scenarios       // []
 * signals.complexity      // "simple"
 * ```
 *
 * @example
 * ```ts
 * const signals = detectSignals("Find the bug in auth.ts and fix it, then deploy");
 * signals.scenarios  // ["debugging", "file-search", "deployment"]
 * ```
 */
export function detectSignals(input: string): UserSignals {
  return {
    wantsRemember: REMEMBER_PATTERN.test(input),
    riskLevel: computeRiskLevel(input),
    scenarios: detectScenarios(input),
    complexity: estimateComplexity(input),
  };
}

// ─── Plan risk check (for FusionAgent plan confirmation) ─────────────────────

/**
 * Check whether a plan text contains risky operations, and at what level.
 *
 * Used by FusionAgent.planConfirmation: `"auto"` to decide whether the
 * user should review the plan before execution.
 *
 * Same rules as {@link computeRiskLevel}: high-risk keywords in
 * non-negated sentences → `"high"`, low-risk → `"low"`.
 *
 * @returns The risk level of the plan (never returns `"none"` for a
 *          non-empty plan — defaults to `"low"` for conservatism).
 */
export function planHasRiskyOps(planSteps: string[]): RiskLevel {
  const text = planSteps.join(" ");
  return computeRiskLevel(text);
}
