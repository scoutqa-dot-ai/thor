/**
 * Policy engine — evaluates whether a tool call is allowed or blocked.
 * Default action is always block — tools must be explicitly allowed.
 *
 * Includes startup validation that guards against upstream tool-set drift:
 *   1. Every discovered tool must be covered by at least one rule.
 *   2. Every rule must match at least one discovered tool.
 */

import type { PolicyConfig, PolicyRule } from "./config.js";

export type PolicyDecision = "allow" | "block";

/**
 * Match a tool name against a pattern.
 * Supports: "*" (match everything), "prefix*" (starts-with), exact match.
 */
function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
}

/**
 * Check if a rule applies to a given upstream name.
 */
function ruleMatchesUpstream(rule: PolicyRule, upstream: string): boolean {
  return rule.upstream === upstream || rule.upstream === "*";
}

// ── Validation ─────────────────────────────────────────────────────────────

export interface UpstreamToolSet {
  upstream: string;
  tools: string[];
}

export class PolicyValidationError extends Error {
  constructor(
    public readonly uncoveredTools: string[],
    public readonly orphanRules: string[],
  ) {
    const parts: string[] = [];
    if (uncoveredTools.length > 0) {
      parts.push(
        `Tools without policy coverage:\n${uncoveredTools.map((t) => `  - ${t}`).join("\n")}`,
      );
    }
    if (orphanRules.length > 0) {
      parts.push(
        `Policy rules matching no tools:\n${orphanRules.map((r) => `  - ${r}`).join("\n")}`,
      );
    }
    super(`Policy validation failed.\n${parts.join("\n")}`);
    this.name = "PolicyValidationError";
  }
}

/**
 * Validate that the policy config fully covers the discovered tool set
 * and that every rule matches at least one real tool.
 *
 * Throws PolicyValidationError if validation fails.
 */
export function validatePolicy(config: PolicyConfig, toolSets: UpstreamToolSet[]): void {
  const uncoveredTools: string[] = [];
  const ruleHits = new Map<number, boolean>();

  // Initialize all rules as unmatched
  for (let i = 0; i < config.rules.length; i++) {
    ruleHits.set(i, false);
  }

  // Check every tool is covered by at least one rule
  for (const { upstream, tools } of toolSets) {
    for (const toolName of tools) {
      let covered = false;
      for (let i = 0; i < config.rules.length; i++) {
        const rule = config.rules[i];
        if (!ruleMatchesUpstream(rule, upstream)) continue;
        if (matchPattern(rule.toolPattern, toolName)) {
          covered = true;
          ruleHits.set(i, true);
          // Don't break — continue to mark all matching rules as having hits
        }
      }
      if (!covered) {
        uncoveredTools.push(`${upstream}::${toolName}`);
      }
    }
  }

  // Check every rule matched at least one real tool
  const orphanRules: string[] = [];
  for (let i = 0; i < config.rules.length; i++) {
    if (!ruleHits.get(i)) {
      const rule = config.rules[i];
      orphanRules.push(`[${rule.action}] ${rule.upstream}::${rule.toolPattern}`);
    }
  }

  if (uncoveredTools.length > 0 || orphanRules.length > 0) {
    throw new PolicyValidationError(uncoveredTools, orphanRules);
  }
}

// ── Runtime evaluation ─────────────────────────────────────────────────────

/**
 * Find the first matching rule for a tool call.
 * Returns the rule's action, or "block" if no rule matches.
 */
export function evaluatePolicy(
  config: PolicyConfig,
  upstream: string,
  toolName: string,
): PolicyDecision {
  for (const rule of config.rules) {
    if (!ruleMatchesUpstream(rule, upstream)) continue;
    if (matchPattern(rule.toolPattern, toolName)) {
      return rule.action;
    }
  }
  return "block";
}

/**
 * Get all rules that match a given upstream (for logging/debugging).
 */
export function getRulesForUpstream(config: PolicyConfig, upstream: string): PolicyRule[] {
  return config.rules.filter((r) => ruleMatchesUpstream(r, upstream));
}
