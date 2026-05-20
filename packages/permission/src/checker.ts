import path from 'node:path';
import { checkPathSafety, getDangerousPathReason, getPathsForPermissionCheck, normalizeCaseForComparison } from './path-safety.js';
import { findDenyRule, findAskRule, findAllowRule, upsertRule } from './rules.js';
import { pathInAnyWorkingDir } from './workspace.js';
import { checkEditableInternalPath, checkReadableInternalPath } from './internal-paths.js';
import type {
  PermissionConfig,
  PermissionContext,
  PermissionMode,
  PermissionOutcome,
  PermissionRule,
  PermissionPrompt,
  PermissionUpdate,
  ToolPermissionMeta,
  DecisionReason,
  RuleScope,
} from './types.js';

// ── Suggestion helpers ────────────────────────────────────────────────────────

function suggestionsForPath(
  toolName:    string,
  targetPath:  string | undefined,
  context:     Pick<PermissionContext, 'workspaceRoot' | 'additionalWorkingDirs'>,
): PermissionUpdate[] {
  const suggestions: PermissionUpdate[] = [];
  const allRoots = [context.workspaceRoot, ...(context.additionalWorkingDirs ?? [])];

  if (!targetPath) {
    // Non-file tool: suggest always-allow for this tool in session scope
    suggestions.push({
      type:        'addRules',
      rules:       [{ tool: toolName, action: 'allow' }],
      destination: 'session',
    });
    return suggestions;
  }

  // File tool: suggest adding the directory to session allow list
  const dir = path.dirname(path.resolve(targetPath));
  suggestions.push({
    type:        'addDirectories',
    directories: [dir],
    destination: 'session',
  });

  // RESP-03: only suggest a path-scoped rule when the directory is inside the
  // workspace root (path.relative returns an absolute path or starts with '..'
  // when they are on different drives or the target is above the root).
  for (const root of allRoots) {
    const rel = path.relative(root, dir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      suggestions.push({
        type:        'addRules',
        rules:       [{ tool: toolName, pathGlob: `/${rel.replace(/\\/g, '/')}/**`, action: 'allow' }],
        destination: 'session',
      });
      break;
    }
  }

  return suggestions;
}

// ── PermissionEngine ──────────────────────────────────────────────────────────

/**
 * Central permission Façade.
 *
 * Instantiate once per session and inject:
 *   - mode: 'ask' | 'auto' | 'bypass'
 *   - rules: loaded from global + project + session settings
 *   - ask: UI/CLI callback for interactive permission prompts
 *   - onRulePersisted: saves "always allow/deny" rules to settings files
 *
 * Then call engine.gate(toolName, input, meta, context) before every tool execution.
 */
export class PermissionEngine {
  private rules: PermissionRule[];
  /** Current permission mode — mutable so allow_session can escalate to bypass. */
  private mode: PermissionMode;

  constructor(private readonly config: PermissionConfig) {
    this.rules = [...config.rules];
    this.mode  = config.mode;
  }

  /**
   * Overrides the active permission mode for the lifetime of this engine instance.
   * Used by the allow_session response to switch to bypass for the rest of the session.
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
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
    if (this.mode === 'bypass') {
      return { granted: true, decisionReason: { type: 'mode', mode: 'bypass' } };
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
      if (reason) {
        const suggestions = suggestionsForPath(toolName, extractedPath, context);
        return this.promptUser(toolName, input, meta, reason, suggestions, context);
      }
    }

    // ── Step 7: ask rules ──────────────────────────────────────────────────
    for (const p of allPaths.length ? allPaths : [undefined]) {
      const rule = findAskRule(this.rules, toolName, p, context);
      if (rule) {
        return this.promptUser(
          toolName, input, meta,
          `an "ask" rule requires confirmation for ${toolName}`,
          [], context,
        );
      }
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
    if (this.mode === 'auto') {
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
    const suggestions = suggestionsForPath(toolName, extractedPath, context);
    return this.promptUser(toolName, input, meta, undefined, suggestions, context);
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
  removeRule(tool: string, pathGlob: string | undefined, scope: RuleScope): void {
    this.rules = this.rules.filter(
      r => !(
        normalizeCaseForComparison(r.tool)     === normalizeCaseForComparison(tool) &&
        r.pathGlob === pathGlob &&
        r.scope    === scope
      ),
    );
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async promptUser(
    toolName:    string,
    input:       unknown,
    meta:        ToolPermissionMeta,
    reason:      string | undefined,
    suggestions: PermissionUpdate[],
    context:     PermissionContext,
  ): Promise<PermissionOutcome> {
    // Per-call override wins (lets each turn route the prompt through its
    // own SSE event stream). Falls back to engine-level config.
    const askFn = context.ask ?? this.config.ask;
    if (!askFn) {
      // Headless / daemon mode — no callback → deny rather than hang
      return {
        granted:      false,
        reason:       `no ask callback; denying "${toolName}" in headless mode`,
        decisionReason: { type: 'other', reason: 'headless mode: no ask callback configured' },
      };
    }

    const prompt: PermissionPrompt = {
      toolName,
      input,
      riskLevel:   meta.riskLevel,
      accessType:  meta.accessType,
      gateReason:  reason,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };

    const response = await askFn(prompt);

    switch (response.action) {
      case 'allow':
        return { granted: true };

      case 'allow_session':
        // Switch to bypass for the rest of this session — no further prompts.
        this.setMode('bypass');
        return { granted: true, decisionReason: { type: 'mode', mode: 'bypass' } };

      case 'deny':
        return {
          granted:        false,
          reason:         response.reason ?? 'denied by user',
          decisionReason: { type: 'other', reason: response.reason ?? 'user denied' },
        };

      case 'always_allow': {
        // BUG-04 fix: pass real input so extractPath can derive the correct path.
        const rule = this.buildRule('allow', toolName, meta, response.scope, context, input);
        this.rules = upsertRule(this.rules, rule);
        await this.config.onRulePersisted?.(rule);
        return { granted: true, decisionReason: { type: 'rule', rule } };
      }

      case 'always_deny': {
        // BUG-04 fix: pass real input so extractPath can derive the correct path.
        const rule = this.buildRule('deny', toolName, meta, response.scope, context, input);
        this.rules = upsertRule(this.rules, rule);
        await this.config.onRulePersisted?.(rule);
        return {
          granted:      false,
          reason:       'permanently denied by user',
          decisionReason: { type: 'rule', rule },
        };
      }
    }
  }

  private buildRule(
    action:   'allow' | 'deny',
    toolName: string,
    meta:     ToolPermissionMeta,
    scope:    PermissionRule['scope'],
    context:  PermissionContext,
    input:    unknown,
  ): PermissionRule {
    // BUG-04 fix: was meta.extractPath?.({}) — must use the real input so the
    // path is extracted correctly (empty object would always yield undefined).
    const extractedPath = meta.extractPath?.(input);
    let pathGlob: string | undefined;

    if (extractedPath) {
      const dir = path.dirname(path.resolve(extractedPath));

      // Check primary workspace root first, then additional working dirs.
      // The first root that contains the dir wins — this produces a tidy
      // workspace-relative /rel/** glob instead of a raw //absolute/** one.
      const allRoots = [
        context.workspaceRoot,
        ...(context.additionalWorkingDirs ?? []),
      ];

      for (const root of allRoots) {
        const rel = path.relative(root, dir);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          pathGlob = `/${rel.replace(/\\/g, '/')}/**`;
          break;
        }
      }

      if (!pathGlob) {
        // Outside every working dir, same drive — anchor to filesystem root.
        // This avoids a pathGlob:undefined rule silently allowing the tool on
        // ALL paths.
        const primaryRel = path.relative(context.workspaceRoot, dir);
        if (!path.isAbsolute(primaryRel)) {
          const posixDir = dir.replace(/\\/g, '/');
          const withoutLeadingSlash = posixDir.startsWith('/') ? posixDir.slice(1) : posixDir;
          pathGlob = `//${withoutLeadingSlash}/**`;
        }
        // Windows cross-drive: path.relative returns the absolute target path.
        // We cannot express a cross-drive scope in the current glob convention,
        // so pathGlob remains undefined (broad allow). Acceptable edge-case for V1.
      }
    }

    return { action, tool: toolName, pathGlob, scope };
  }
}

// ── Convenience type re-export ────────────────────────────────────────────────

export type { DecisionReason };
