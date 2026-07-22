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
 * Risk level for an operation described in the user's input.
 *
 * - `none` — no risky keywords detected.
 * - `low`  — routine but impactful ops (deploy, release, migrate, reset).
 * - `high` — destructive / irreversible ops (delete, drop, force push, etc.).
 */
export type RiskLevel = "none" | "low" | "high";

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
  // English
  "rm -rf", "force push", "hard reset",
  "delete", "drop", "destroy", "purge", "format", "truncate",
  // CJK (traditional & simplified)
  "删除", "刪除",           // delete
  "销毁", "銷毀",           // destroy
  "格式化",                 // format
  "清空",                   // purge / truncate
  "丢弃", "丟棄",           // drop / discard
  "彻底删除", "徹底刪除",   // permanently delete
  "强制推送", "強制推送",   // force push
  "硬重置",                 // hard reset
];

/**
 * Low-risk keywords: impactful but routine operations.
 *
 * These trigger `riskLevel: "low"` — worth noting but not alarming.
 */
const LOW_RISK_KEYWORDS = [
  // English
  "deploy", "release", "publish", "ship", "migrate", "reset",
  // CJK (traditional & simplified)
  "部署",                   // deploy
  "发布", "發布",           // release / publish
  "上线", "上線",           // ship / go live
  "迁移", "遷移",           // migrate
  "重置",                   // reset
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

/**
 * Contrastive conjunctions used to split chunks so negation in one clause
 * doesn't suppress risk keywords in a contrasting clause.
 *
 * English entries use `\b` boundaries; CJK entries use plain substring match
 * (no `\b`) because CJK characters aren't `\w` in JavaScript regex.
 */
const CONTRAST_SPLITTER_EN = /\b(?:but|however|yet|though|although)\b/i;
const CONTRAST_SPLITTER_CJK = /(?:但是|然而|不过|可是|但|却|卻)/i;

/** Build a regex for a risk keyword. */
function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Multi-word phrases and CJK keywords use plain substring match (no \b
  // boundaries) because \b doesn't work between CJK characters.
  if (keyword.includes(" ") || /[^\x00-\x7F]/.test(keyword)) {
    return new RegExp(escaped, "i");
  }
  return new RegExp(`\\b${escaped}\\b`, "i");
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
 * 1. Split input into clauses (by punctuation + contrastive conjunctions).
 * 2. In clauses with negation markers, risky keywords are ignored.
 * 3. Otherwise, any high-risk match → `"high"`.
 * 4. Any low-risk match → `"low"`.
 * 5. Nothing matched → `"none"`.
 *
 * Supports both English and CJK risk keywords.
 */
function computeRiskLevel(input: string): RiskLevel {
  // 1) Split on punctuation (sentence-ending + clause separators)
  const punctuationChunks = input
    .split(/[.!?。！？\n,，;；]+/)
    .filter((s) => s.trim().length > 0);

  // 2) Split each chunk on contrastive conjunctions so negation in one
  //    clause doesn't suppress risk keywords in a contrasting clause.
  //    e.g. "don't delete the config but do format the disk"
  //         → ["don't delete the config ", " do format the disk"]
  //         "format" is correctly detected because only the first chunk is negated.
  const chunks = punctuationChunks.length > 0
    ? punctuationChunks
        .flatMap((c) => c.split(CONTRAST_SPLITTER_EN))
        .flatMap((c) => c.split(CONTRAST_SPLITTER_CJK))
        .filter((s) => s.trim().length > 0)
    : [input];

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
 * ```
 */
export function detectSignals(input: string): UserSignals {
  return {
    wantsRemember: REMEMBER_PATTERN.test(input),
    riskLevel: computeRiskLevel(input),
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
  const level = computeRiskLevel(text);
  // Never return "none" for a non-empty plan — default to "low" for
  // conservatism, so callers that check !== "none" still trigger
  // plan-review flows even when no explicit risk keywords are detected.
  if (level === "none" && planSteps.length > 0) return "low";
  return level;
}
