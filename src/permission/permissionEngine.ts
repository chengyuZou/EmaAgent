// 这里根据权限规则和用户选择，决定一次工具调用能不能执行。

import path from 'node:path';
import { checkPathSafety, getDangerousPathReason, getPathsForPermissionCheck, normalizeCaseForComparison } from './paths/pathSafety.js';
import { findDenyRule, findAskRule, findAllowRule } from './policy/permissionRules.js';
import type { PermissionRuleStore } from './policy/permissionRuleStore.js';
import { pathInAnyWorkingDir } from './paths/workspaceBoundary.js';
import { checkEditableInternalPath, checkReadableInternalPath } from './paths/internalPaths.js';
import { SessionGrantStore } from './policy/sessionGrants.js';
import type {
  PermissionConfig,
  PermissionContext,
  PermissionMode,
  PermissionOutcome,
  PermissionRule,
  PersistedPermissionRule,
  PermissionPrompt,
  ToolPermissionMeta,
  DecisionReason,
  PermissionToolIdentity,
} from './types.js';

// ── PermissionEngine ──────────────────────────────────────────────────────────

/**
 * Permission 裁决的唯一公共入口。
 *
 * 在应用装配根构造一次,注入:
 *   - mode:'ask' | 'auto' | 'bypass'
 *   - ruleStore:持久化规则(永久 allow/deny/ask,存 profile.db.permission_rules)
 *   - ask:UI/CLI 交互回调,用于需要用户确认时弹窗
 *
 * builtinRules 由代码提供(如危险命令 deny),不进数据库;用户规则由 Store 管理,
 * addRule/removeRule/setRuleEnabled 立即写库并刷新内存匹配快照。Session 级临时
 * 授权由内存 SessionGrantStore 管理,不进 Store。
 *
 * 每次 Tool 执行前调用 engine.gate(tool, input, meta, context)。
 */
export class PermissionEngine {
  private builtinRules: readonly PermissionRule[];
  private rules: PermissionRule[];
  /** 全局默认模式。 */
  private mode: PermissionMode;
  private readonly sessionGrants = new SessionGrantStore();

  constructor(
    private readonly config: PermissionConfig,
    private readonly ruleStore: PermissionRuleStore,
  ) {
    this.builtinRules = config.builtinRules ?? [];
    this.mode  = config.mode;
    this.rules = this.reloadRules();
  }

  /** 从内置规则 + Store 启用规则重新加载匹配用规则集。 */
  private reloadRules(): PermissionRule[] {
    return [...this.builtinRules, ...this.ruleStore.listEnabled()];
  }

  /**
   * 覆盖全局默认模式。allow_session 不改模式,只写精确 Session Grant。
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** 清理只属于一个 Session 的临时授权。 */
  clearSession(sessionId: string): void {
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
   *   5. Internal editable path (session memory / scratch) → allow
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
    tool:     string | PermissionToolIdentity,
    input:    unknown,
    meta:     ToolPermissionMeta,
    context:  PermissionContext,
  ): Promise<PermissionOutcome> {
    const toolId = typeof tool === 'string' ? tool : tool.id;
    const toolName = typeof tool === 'string' ? tool : tool.name;
    const toolDescription = typeof tool === 'string' ? undefined : tool.description;
    // Resolve all paths once (original + symlink-resolved forms)
    const extractedPath = meta.extractPath?.(input);
    const permissionPath = extractedPath
      ? resolvePermissionPath(extractedPath, context.workspaceRoot)
      : undefined;
    const allPaths = permissionPath ? getPathsForPermissionCheck(permissionPath) : [];
    const sessionAction = { toolName: toolId, input, meta, resolvedPaths: allPaths, context };

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
      const rule = findDenyRule(this.rules, toolId, p, context);
      if (rule) {
        return {
          granted:      false,
          reason:       `denied by ${rule.scope} rule`,
          decisionReason: { type: 'rule', rule },
        };
      }
    }

    // ── Step 4: bypass mode ────────────────────────────────────────────────
    const effectiveMode = this.mode;

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
        return this.promptUser(toolId, toolName, toolDescription, input, meta, reason, allPaths, context);
      }
    }

    // ── Step 7: ask rules ──────────────────────────────────────────────────
    for (const p of allPaths.length ? allPaths : [undefined]) {
      const rule = findAskRule(this.rules, toolId, p, context);
      if (rule) {
        return this.promptUser(
          toolId, toolName, toolDescription, input, meta,
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
      const rule = findAllowRule(this.rules, toolId, undefined, context);
      if (rule) return { granted: true, decisionReason: { type: 'rule', rule } };
    } else {
      let matchedRule: PermissionRule | undefined;
      const allCovered = allPaths.every(p => {
        const r = findAllowRule(this.rules, toolId, p, context);
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
    return this.promptUser(toolId, toolName, toolDescription, input, meta, undefined, allPaths, context);
  }

  /** 列出全部持久化规则(含禁用),供 UI 展示与管理。 */
  getRules(): ReadonlyArray<PersistedPermissionRule> {
    return this.ruleStore.list();
  }

  /** 新增或按 (tool, pathGlob, scope, workspaceRoot) 去重更新;返回持久化结果。 */
  addRule(input: PermissionRule): PersistedPermissionRule {
    const persisted = this.ruleStore.upsert(input);
    this.rules = this.reloadRules();
    return persisted;
  }

  /** 启停一条规则。 */
  setRuleEnabled(id: string, enabled: boolean): void {
    this.ruleStore.setEnabled(id, enabled);
    this.rules = this.reloadRules();
  }

  /** 按 id 删除持久化规则;不存在返回 false。内置规则不可删。 */
  removeRule(id: string): boolean {
    const deleted = this.ruleStore.delete(id);
    if (deleted) this.rules = this.reloadRules();
    return deleted;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async promptUser(
    toolId:   string,
    toolName: string,
    toolDescription: string | undefined,
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
      toolId,
      toolName,
      toolDescription,
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
        ? getPathsForPermissionCheck(resolvePermissionPath(currentExtractedPath, context.workspaceRoot))
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
          toolName: toolId,
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

/** 工具的相对路径和实际执行保持一致：统一以当前 workspace 为基准。 */
function resolvePermissionPath(candidate: string, workspaceRoot: string): string {
  if (candidate.startsWith('~') || path.isAbsolute(candidate)) return candidate;
  return path.resolve(workspaceRoot || process.cwd(), candidate);
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
