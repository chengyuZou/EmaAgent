// 这里根据权限规则和用户选择，决定一次工具调用能不能执行。

import path from 'node:path';
import { checkPathSafety, getDangerousPathReason, getPathsForPermissionCheck, normalizeCaseForComparison } from './path-safety.js';
import { findDenyRule, findAskRule, findAllowRule, upsertRule } from './rules.js';
import { pathInAnyWorkingDir } from './workspace.js';
import { checkEditableInternalPath, checkReadableInternalPath } from './internal-paths.js';
import { SessionGrantStore } from './session-grants.js';
import type {
  PermissionConfig,
  PermissionContext,
  PermissionMode,
  PermissionOutcome,
  PermissionRule,
  PermissionPrompt,
  ToolPermissionMeta,
  DecisionReason,
  RuleScope,
} from './types.js';

// ── PermissionEngine ──────────────────────────────────────────────────────────

/**
 * Central permission Facade.
 *
 * Instantiate once in the application composition root and inject:
 *   - mode: 'ask' | 'auto' | 'bypass'
 *   - rules: loaded from global + project + session settings
 *   - ask: UI/CLI callback for interactive permission prompts
 *   - onRulePersisted: saves "always allow/deny" rules to settings files
 *
 * Then call engine.gate(toolName, input, meta, context) before every tool execution.
 */
export class PermissionEngine {
  private rules: PermissionRule[];
  /** Global default mode (used when no session-specific override applies). */
  private mode: PermissionMode;
  /**
   * Per-session mode overrides. This is an explicit host setting and is not
   * changed by a single `allow_session` response.
   */
  private readonly sessionModes = new Map<string, PermissionMode>();
  private readonly sessionGrants = new SessionGrantStore();

  constructor(private readonly config: PermissionConfig) {
    this.rules = [...config.rules];
    this.mode  = config.mode;
  }

  /**
   * Override the global default mode (affects sessions with no per-session override).
   * Prefer setSessionMode() for session-scoped escalation.
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Override the permission mode for a single session.
   * Used by `allow_session` so that approving in session A does not bypass
   * permission checks in session B.
   */
  setSessionMode(sessionId: string, mode: PermissionMode): void {
    this.sessionModes.set(sessionId, mode);
  }

  /** 清理只属于一个 Session 的模式和临时授权。 */
  clearSession(sessionId: string): void {
    this.sessionModes.delete(sessionId);
    this.sessionGrants.clear(sessionId);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Gate a tool call through the full permission pipeline.
   *
   * Pipeline (12 steps):
   *
   *  Bypass-immune (always run regardless of mode):
   *   1. Tool's own safetyCheck (bypassImmune tools only)
   *   2. Path safety: shell injection, NTFS ADS, Unix virtual fs — on ALL resolved paths
   *   3. Deny rules
   *
   *  Early carve-outs:
   *   4. bypass mode → allow (non-immune)
   *   5. Internal editable path (session memory / artifacts / scratch) → allow
   *
   *  File-tool safety:
   *   6. Dangerous file/dir names (DANGEROUS_FILES/DIRS) → ask with suggestions
   *
   *  Rule-based:
   *   7. Ask rules → prompt user
   *   8. Allow rules → allow (ALL resolved paths must match)
   *
   *  Mode-based:
   *   9. Reads in workspace → always allow (all modes)
   *  10. Internal readable paths → always allow
   *  11. auto mode: writes in workspace OR low-risk non-file tools → allow
   *  12. Ask user (default for ask mode / anything unresolved)
   */
  async gate(
    toolName: string,
    input:    unknown,
    meta:     ToolPermissionMeta,
    context:  PermissionContext,
  ): Promise<PermissionOutcome> {
    // Resolve all paths once (original + symlink-resolved forms)
    const extractedPath = meta.extractPath?.(input);
    const allPaths      = extractedPath ? getPathsForPermissionCheck(extractedPath) : [];
    const sessionAction = { toolName, input, meta, resolvedPaths: allPaths, context };

    // ── Step 1: bypass-immune tool safety check ────────────────────────────
    if (meta.bypassImmune && meta.safetyCheck) {
      if (meta.safetyCheck(input) === 'deny') {
        return {
          granted:      false,
          reason:       `"${toolName}" safety check rejected this input`,
          decisionReason: { type: 'safetyCheck', reason: 'tool-level safety check failed' },
        };
      }
    }

    // ── Step 2: bypass-immune path safety on every resolved path ───────────
    for (const p of allPaths) {
      const safety = checkPathSafety(p);
      if (!safety.safe) {
        return {
          granted:      false,
          reason:       safety.reason ?? 'unsafe path detected',
          decisionReason: { type: 'safetyCheck', reason: safety.reason ?? 'unsafe path' },
        };
      }
    }

    // ── Step 3: deny rules (checked against every resolved path) ──────────
    for (const p of allPaths.length ? allPaths : [undefined]) {
      const rule = findDenyRule(this.rules, toolName, p, context);
      if (rule) {
        return {
          granted:      false,
          reason:       `denied by ${rule.scope} rule`,
          decisionReason: { type: 'rule', rule },
        };
      }
    }

    // ── Step 4: bypass mode ────────────────────────────────────────────────
    // Use session-specific mode when available; fall back to global default.
    const effectiveMode = context.sessionId
      ? (this.sessionModes.get(context.sessionId) ?? this.mode)
      : this.mode;

    if (effectiveMode === 'bypass') {
      return { granted: true, decisionReason: { type: 'mode', mode: 'bypass' } };
    }

    // 封装型内部工具不暴露文件路径，因此用显式能力证明它只能操作 Core 授予的目录。
    // 能力缺失时继续普通权限流程并最终询问/拒绝，避免仅凭工具名放行。
    if (meta.internalPathCapability) {
      const root = context.internalPaths?.[meta.internalPathCapability];
      if (root) {
        return {
          granted: true,
          decisionReason: {
            type: 'internalCapability',
            capability: meta.internalPathCapability,
            root,
          },
        };
      }
    }

    // ── Step 5: internal editable path carve-outs (write / execute) ───────
    // Must run BEFORE dangerous-dir check; .ema-agent/ is in DANGEROUS_DIRS.
    // BUG-06 fix: check ALL resolved paths, not just the raw extractedPath.
    if (allPaths.length > 0 && meta.accessType !== 'read') {
      const allInternal = allPaths.every(
        p => checkEditableInternalPath(path.resolve(p), context) === 'allow',
      );
      if (allInternal) {
        return {
          granted:      true,
          decisionReason: { type: 'internalPath', path: extractedPath! },
        };
      }
    }

    // ── Step 6: dangerous file / dir name check ────────────────────────────
    // Only applies to file tools. Returns 'ask' (not 'deny') to give the user
    // a chance to explicitly approve — mirrors Claude Code's behaviour.
    for (const p of allPaths) {
      const reason = getDangerousPathReason(p);
      if (reason && !this.sessionGrants.has(context.sessionId, sessionAction)) {
        return this.promptUser(toolName, input, meta, reason, allPaths, context);
      }
    }

    // ── Step 7: ask rules ──────────────────────────────────────────────────
    for (const p of allPaths.length ? allPaths : [undefined]) {
      const rule = findAskRule(this.rules, toolName, p, context);
      if (rule) {
        return this.promptUser(
          toolName, input, meta,
          `an "ask" rule requires confirmation for ${toolName}`,
          allPaths,
          context,
        );
      }
    }

    // 精确 Session Grant 低于 deny/ask 规则和不可绕过安全检查，但高于
    // 普通 allow/default 决策。它只允许用户此前批准过的同一规范化操作。
    if (this.sessionGrants.has(context.sessionId, sessionAction)) {
      return {
        granted: true,
        decisionReason: { type: 'sessionGrant', sessionId: context.sessionId! },
      };
    }

    // ── Step 8: allow rules ────────────────────────────────────────────────
    // BUG-05 fix: ALL resolved paths must be covered by an allow rule.
    // A single matching rule does not suffice if a symlink resolves outside it.
    if (allPaths.length === 0) {
      const rule = findAllowRule(this.rules, toolName, undefined, context);
      if (rule) return { granted: true, decisionReason: { type: 'rule', rule } };
    } else {
      let matchedRule: PermissionRule | undefined;
      const allCovered = allPaths.every(p => {
        const r = findAllowRule(this.rules, toolName, p, context);
        if (r && !matchedRule) matchedRule = r;
        return !!r;
      });
      if (allCovered && matchedRule) {
        return { granted: true, decisionReason: { type: 'rule', rule: matchedRule } };
      }
    }

    // ── Step 9: reads in workspace → always allow (all modes) ─────────────
    if (meta.accessType === 'read' && allPaths.length > 0) {
      if (allPaths.every(p => pathInAnyWorkingDir(p, context))) {
        return { granted: true, decisionReason: { type: 'workingDir' } };
      }
    }

    // ── Step 10: internal readable paths ──────────────────────────────────
    // API-04 fix: check ALL resolved paths, not just the raw extractedPath.
    if (meta.accessType === 'read' && allPaths.length > 0) {
      const allReadable = allPaths.every(
        p => checkReadableInternalPath(path.resolve(p), context) === 'allow',
      );
      if (allReadable) {
        return {
          granted:      true,
          decisionReason: { type: 'internalPath', path: extractedPath! },
        };
      }
    }

    // ── Step 11: auto mode decisions ───────────────────────────────────────
    if (effectiveMode === 'auto') {
      // Writes / executes in workspace in auto mode
      if (allPaths.length > 0 && allPaths.every(p => pathInAnyWorkingDir(p, context))) {
        return { granted: true, decisionReason: { type: 'workingDir' } };
      }
      // Low-risk non-file tools (e.g. web search)
      if (allPaths.length === 0 && meta.riskLevel === 'low') {
        return { granted: true, decisionReason: { type: 'mode', mode: 'auto' } };
      }
    }

    // ── Step 12: ask user ──────────────────────────────────────────────────
    return this.promptUser(toolName, input, meta, undefined, allPaths, context);
  }

  getRules(): ReadonlyArray<PermissionRule> {
    return this.rules;
  }

  addRule(rule: PermissionRule): void {
    this.rules = upsertRule(this.rules, rule);
  }

  /**
   * Remove a rule by its unique (tool, pathGlob, scope) key.
   * Used when the user deletes a persisted rule from the settings UI.
   * No-op if the rule does not exist.
   */
  removeRule(
    tool: string,
    pathGlob: string | undefined,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    this.rules = this.rules.filter(
      r => !(
        normalizeCaseForComparison(r.tool)     === normalizeCaseForComparison(tool) &&
        r.pathGlob === pathGlob &&
        r.scope    === scope &&
        r.sessionId === sessionId
      ),
    );
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async promptUser(
    toolName: string,
    input:    unknown,
    meta:     ToolPermissionMeta,
    reason:   string | undefined,
    resolvedPaths: readonly string[],
    context:  PermissionContext,
  ): Promise<PermissionOutcome> {
    // Per-call override wins (lets each turn route the prompt through its
    // own SSE event stream). Falls back to engine-level config.
    const askFn = context.ask ?? this.config.ask;
    if (!askFn) {
      // Headless / daemon mode — no callback → deny rather than hang
      return {
        granted:        false,
        reason:         `no ask callback; denying "${toolName}" in headless mode`,
        decisionReason: { type: 'other', reason: 'headless mode: no ask callback configured' },
      };
    }

    const prompt: PermissionPrompt = {
      toolName,
      input,
      riskLevel:  meta.riskLevel,
      accessType: meta.accessType,
      gateReason: reason,
      sessionId:  context.sessionId,
      turnId:     context.turnId,
      toolCallId: context.toolCallId,
    };

    const response = await askFn(prompt);

    if (response.action !== 'deny') {
      const currentExtractedPath = meta.extractPath?.(input);
      const currentPaths = currentExtractedPath
        ? getPathsForPermissionCheck(currentExtractedPath)
        : [];
      if (!sameResolvedPaths(resolvedPaths, currentPaths)) {
        return {
          granted: false,
          reason: 'permission target changed while awaiting approval',
          decisionReason: {
            type: 'safetyCheck',
            reason: 'resolved path changed during approval',
          },
        };
      }
    }

    switch (response.action) {
      case 'allow':
        return { granted: true };

      case 'allow_session': {
        if (!context.sessionId) {
          return {
            granted: false,
            reason: 'session-scoped approval requires a sessionId',
            decisionReason: { type: 'other', reason: 'missing session identity' },
          };
        }
        this.sessionGrants.allow(context.sessionId, {
          toolName,
          input,
          meta,
          resolvedPaths,
          context,
        });
        return {
          granted: true,
          decisionReason: { type: 'sessionGrant', sessionId: context.sessionId },
        };
      }

      case 'deny':
        return {
          granted:        false,
          reason:         response.reason ?? 'denied by user',
          decisionReason: { type: 'other', reason: response.reason ?? 'user denied' },
        };
    }
  }

}

// ── Convenience type re-export ────────────────────────────────────────────────

export type { DecisionReason };

function sameResolvedPaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (value: string): string => normalizeCaseForComparison(path.resolve(value));
  const normalizedLeft = left.map(normalize).sort();
  const normalizedRight = right.map(normalize).sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
