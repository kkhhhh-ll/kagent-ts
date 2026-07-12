import type { Skill } from "../skills/types";

/**
 * Fast-path skill matching — zero-LLM keyword/name matching against the
 * user's input.  Matched skills have their system prompt injected at
 * startup so the LLM never needs to call the `skill` tool for them.
 *
 * This is NOT a replacement for LLM-driven skill activation — it is an
 * eager pre-load for obviously-relevant skills.  The LLM can still call
 * the `skill` tool for skills that didn't match on keywords.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillMatch {
  skill: Skill;
  /** Which keyword(s) triggered the match (empty if matched by name). */
  matchedBy: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Word-boundary-aware substring match.
 *
 * For single words (no spaces), requires the token to appear as a whole
 * word (surrounded by non-alphanumeric characters or string boundaries).
 * For multi-word phrases, does a plain substring match (the phrase itself
 * acts as its own boundary).
 */
function wordBoundaryMatch(text: string, token: string): boolean {
  if (token.includes(" ")) {
    // Multi-word: plain substring match
    return text.includes(token);
  }
  // Single word: require word boundaries
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`, "i");
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Match skills whose name or keywords appear in the user's input.
 *
 * Matching is case-insensitive and uses word-boundary-aware substring
 * matching for multi-word terms.
 *
 * @param input   The raw user input string.
 * @param skills  Available skills (metadata-only is fine — no systemPrompt needed).
 * @returns        Matched skills sorted by specificity (keywords > name match).
 */
export function matchSkills(
  input: string,
  skills: Skill[],
): SkillMatch[] {
  const results: SkillMatch[] = [];
  const lower = input.toLowerCase();

  for (const skill of skills) {
    const matchedBy: string[] = [];

    // 1) Name match — `code-reviewer` matches "code review" or "review code"
    //    Uses word-boundary-aware matching to avoid "code" matching "unicode"
    if (skill.name) {
      const nameTokens = skill.name.toLowerCase().split(/[-_\s]+/);
      if (nameTokens.every((t) => wordBoundaryMatch(lower, t))) {
        matchedBy.push(`name:${skill.name}`);
      }
    }

    // 2) Keyword match — uses word boundaries for single words
    if (skill.keywords && skill.keywords.length > 0) {
      for (const kw of skill.keywords) {
        if (wordBoundaryMatch(lower, kw.toLowerCase())) {
          matchedBy.push(kw);
        }
      }
    }

    if (matchedBy.length > 0) {
      results.push({ skill, matchedBy });
    }
  }

  return results;
}

/**
 * Build a system prompt fragment from matched skills.
 *
 * Returns empty string if no matches.
 */
export function buildMatchedSkillsPrompt(matches: SkillMatch[]): string {
  if (matches.length === 0) return "";

  const lines = [
    "## Auto-Activated Skills",
    "The following skills matched the user's request and are pre-loaded for this task:",
    "",
  ];

  for (const m of matches) {
    lines.push(
      `**${m.skill.name}** — ${m.skill.description} (matched: ${m.matchedBy.join(", ")})`,
    );
  }

  return lines.join("\n");
}
