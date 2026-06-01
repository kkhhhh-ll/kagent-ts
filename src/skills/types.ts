import { Tool } from "../tools/types";

/**
 * A Skill is a reusable capability that can be loaded into the agent's
 * system prompt on demand (progressive disclosure).
 *
 * Each skill carries:
 * - A system prompt fragment with instructions for the LLM
 * - Optional tools the skill needs
 * - Optional keywords that trigger automatic activation
 */
export interface Skill {
  /** Unique identifier for this skill. */
  name: string;

  /** Human-readable description (shown to the LLM or caller). */
  description: string;

  /**
   * System prompt content injected into the agent's system message
   * when this skill is activated.
   */
  systemPrompt: string;

  /**
   * Optional keywords for auto-detection.
   * When user input contains any of these, the skill is activated automatically.
   */
  keywords?: string[];

  /**
   * Optional tools that this skill provides.
   * These are registered when the skill activates and unregistered on deactivation.
   */
  tools?: Tool[];
}

/**
 * Status of a skill within the SkillManager.
 */
export interface SkillStatus {
  name: string;
  description: string;
  active: boolean;
  loadedAt?: Date;
}
