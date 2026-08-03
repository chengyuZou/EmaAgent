// 统一完成路径安全、规则、执行模式、Session 授权和用户批准判定。

import path from 'node:path';
import type { SessionId } from '@ema-agent/ids';
import {
  checkPathSafety,
  getDangerousPathReason,
  getPathsForPermissionCheck,
} from './paths/pathSafety.js';
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
} from './paths/internalPaths.js';
import { pathInWorkingDir } from './paths/workspaceBoundary.js';
import {
  findAllowRule,
  findAskRule,
  findDenyRule,
} from './policy/permissionRules.js';
import type { PermissionRuleStore } from './policy/permissionRuleStore.js';
import { SessionGrantStore } from './policy/sessionGrants.js';
import {
  createPermissionRequestFingerprint,
  type ResolvedPermissionTarget,
} from './requestFingerprint.js';
import type {
  AskPermissionFn,
  PermissionAuthorizer,
  PermissionContext,
  PermissionDecision,
  PermissionEngineOptions,
  PermissionPrompt,
  PermissionRequest,
  PermissionRule,
  PermissionRuleCatalog,
  PersistedPermissionRule,
} from './types.js';

interface PreparedPermissionRequest {
  request: PermissionRequest;
  targets: readonly ResolvedPermissionTarget[];
  fingerprint: string;
  internalPathRoot?: string;
}

type Evaluation =
  | { kind: 'decision'; decision: PermissionDecision }
  | { kind: 'prompt'; gateReason?: string };

/**
 * Permission 的唯一业务入口。
 *
 * Engine 不保存当前模式：模式属于一次 Turn/Session 的执行快照，放在每个请求的
 * PermissionContext 中，避免并发 Session 互相覆盖权限状态。
 */
export class PermissionEngine implements PermissionAuthorizer, PermissionRuleCatalog {
  private readonly sessionGrants = new SessionGrantStore();
  private readonly builtinRules: readonly PermissionRule[];
  private readonly allowBypassPermissions: boolean;
  private rules: PermissionRule[];

  constructor(
    private readonly ruleStore: PermissionRuleStore,
    options: PermissionEngineOptions = {},
  ) {
    this.builtinRules = options.builtinRules ?? [];
    this.allowBypassPermissions = options.allowBypassPermissions ?? false;
    this.rules = this.reloadRules();
  }

  async authorize(
    request: PermissionRequest,
    ask?: AskPermissionFn,
  ): Promise<PermissionDecision> {
    const prepared = this.prepareRequest(request);
    if ('outcome' in prepared) return prepared;

    const evaluation = this.evaluate(prepared);
    if (evaluation.kind === 'decision') return evaluation.decision;

    if (!ask) {
      return deny(
        `没有可用的批准界面，已拒绝“${request.tool.name}”`,
        { type: 'headless' },
      );
    }

    return this.promptUser(prepared, ask, evaluation.gateReason);
  }

  clearSession(sessionId: SessionId): void {
    this.sessionGrants.clear(sessionId);
  }

  listRules(): readonly PersistedPermissionRule[] {
    return this.ruleStore.list();
  }

  saveRule(rule: PermissionRule): PersistedPermissionRule {
    const persisted = this.ruleStore.upsert(normalizeRule(rule));
    this.rules = this.reloadRules();
    return persisted;
  }

  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const changed = this.ruleStore.setEnabled(ruleId, enabled);
    if (changed) this.rules = this.reloadRules();
    return changed;
  }

  removeRule(ruleId: string): boolean {
    const removed = this.ruleStore.delete(ruleId);
    if (removed) this.rules = this.reloadRules();
    return removed;
  }

  private prepareRequest(
    request: PermissionRequest,
  ): PreparedPermissionRequest | PermissionDecision {
    try {
      validateRequest(request);
      const targets = request.intent.targets?.map(target => ({
        requestedPath: target.path,
        accessType: target.accessType,
        resolvedPaths: resolveTargetPaths(target.path, request.context),
      })) ?? [];
      const internalPathRoot = request.intent.internalPathCapability
        ? request.context.internalPaths?.[request.intent.internalPathCapability]
        : undefined;
      const fingerprint = createPermissionRequestFingerprint({
        toolId: request.tool.id,
        input: request.input,
        intent: request.intent,
        mode: request.context.mode,
        workspaceRoot: request.context.workspaceRoot,
        resolvedTargets: targets,
        internalPathRoot,
      });

      return { request, targets, fingerprint, internalPathRoot };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Permission 请求无效';
      return deny(message, { type: 'invalidRequest', reason: message });
    }
  }

  private evaluate(prepared: PreparedPermissionRequest): Evaluation {
    const { request, targets, fingerprint } = prepared;
    const { context, intent, tool } = request;
    const ruleTargets = flattenResolvedPaths(targets);

    for (const targetPath of ruleTargets) {
      const safety = checkPathSafety(targetPath);
      if (!safety.safe) {
        const message = safety.reason ?? '目标路径未通过通用安全检查';
        return { kind: 'decision', decision: deny(message, { type: 'pathSafety', reason: message }) };
      }
    }

    const denyRule = findFirstMatchingRule(this.rules, 'deny', tool.id, ruleTargets, context);
    if (denyRule) {
      return {
        kind: 'decision',
        decision: deny(
          `操作被 ${denyRule.scope} deny 规则拒绝`,
          { type: 'rule', rules: [denyRule] },
        ),
      };
    }

    const askRule = findFirstMatchingRule(this.rules, 'ask', tool.id, ruleTargets, context);
    if (askRule) {
      return {
        kind: 'prompt',
        gateReason: `${askRule.scope} ask 规则要求用户确认`,
      };
    }

    if (this.sessionGrants.has(context.sessionId, fingerprint)) {
      return {
        kind: 'decision',
        decision: allow({ type: 'sessionGrant', sessionId: context.sessionId! }),
      };
    }

    const allowRules = findAllowRulesCoveringAll(this.rules, tool.id, ruleTargets, context);
    if (allowRules) {
      return { kind: 'decision', decision: allow({ type: 'rule', rules: allowRules }) };
    }

    if (intent.internalPathCapability && prepared.internalPathRoot && targets.length === 0) {
      return {
        kind: 'decision',
        decision: allow({
          type: 'internalCapability',
          capability: intent.internalPathCapability,
        }),
      };
    }

    if (targets.length > 0 && targets.every(target => isGrantedInternalTarget(target, context))) {
      return {
        kind: 'decision',
        decision: allow({ type: 'internalPath' }),
      };
    }

    if (isWorkspaceRead(targets, context) && intent.riskLevel === 'low') {
      return { kind: 'decision', decision: allow({ type: 'workspace' }) };
    }

    if (context.mode === 'acceptEdits' && isWorkspaceEdit(intent.accessType, targets, context)) {
      return {
        kind: 'decision',
        decision: allow({ type: 'mode', mode: 'acceptEdits' }),
      };
    }

    if (context.mode === 'bypassPermissions') {
      if (!this.allowBypassPermissions) {
        return {
          kind: 'decision',
          decision: deny(
            '当前构建不允许 bypassPermissions',
            { type: 'mode', mode: 'bypassPermissions' },
          ),
        };
      }
      return {
        kind: 'decision',
        decision: allow({ type: 'mode', mode: 'bypassPermissions' }),
      };
    }

    if (intent.promptPolicy === 'neverForTrustedBuiltin') {
      return {
        kind: 'decision',
        decision: allow({ type: 'promptPolicy', policy: intent.promptPolicy }),
      };
    }

    return {
      kind: 'prompt',
      gateReason: firstDangerousTargetReason(targets),
    };
  }

  private async promptUser(
    prepared: PreparedPermissionRequest,
    ask: AskPermissionFn,
    gateReason?: string,
  ): Promise<PermissionDecision> {
    const { request } = prepared;
    const prompt: PermissionPrompt = {
      toolId: request.tool.id,
      toolName: request.tool.name,
      toolDescription: request.tool.description,
      input: request.input,
      riskLevel: request.intent.riskLevel,
      accessType: request.intent.accessType,
      targets: request.intent.targets ?? [],
      gateReason,
      sessionId: request.context.sessionId,
      turnId: request.context.turnId,
      toolCallId: request.context.toolCallId,
    };

    const response = await ask(prompt);
    if (response.action === 'deny') {
      const message = response.reason ?? '用户拒绝了本次操作';
      return deny(message, { type: 'user', action: 'deny' });
    }

    // 等待期间输入、工作区、模式、能力根或 symlink 目标任一变化，都不能沿用旧批准。
    const current = this.prepareRequest(request);
    if ('outcome' in current || current.fingerprint !== prepared.fingerprint) {
      return deny(
        '等待批准期间请求或目标发生变化，已拒绝执行',
        { type: 'requestChanged' },
      );
    }

    const recheck = this.recheckUnbypassablePolicies(current);
    if (recheck) return recheck;

    if (response.action === 'allowSession') {
      const sessionId = request.context.sessionId;
      if (!sessionId) {
        return deny(
          '本会话允许需要明确的 sessionId',
          { type: 'invalidRequest', reason: '缺少 sessionId' },
        );
      }
      this.sessionGrants.allow(sessionId, current.fingerprint);
    }

    return allow({ type: 'user', action: response.action });
  }

  /** 批准返回后只重跑硬安全和 deny；ask 已由本次用户响应解决。 */
  private recheckUnbypassablePolicies(
    prepared: PreparedPermissionRequest,
  ): PermissionDecision | undefined {
    const targetPaths = flattenResolvedPaths(prepared.targets);
    for (const targetPath of targetPaths) {
      const safety = checkPathSafety(targetPath);
      if (!safety.safe) {
        const message = safety.reason ?? '目标路径未通过通用安全检查';
        return deny(message, { type: 'pathSafety', reason: message });
      }
    }

    const rule = findFirstMatchingRule(
      this.rules,
      'deny',
      prepared.request.tool.id,
      targetPaths,
      prepared.request.context,
    );
    return rule
      ? deny(`批准期间新增的 ${rule.scope} deny 规则拒绝了操作`, { type: 'rule', rules: [rule] })
      : undefined;
  }

  private reloadRules(): PermissionRule[] {
    return [...this.builtinRules, ...this.ruleStore.listEnabled()];
  }
}

function validateRequest(request: PermissionRequest): void {
  if (!request.tool.id.trim()) throw new TypeError('Permission 请求缺少 Tool id');
  if (!request.tool.name.trim()) throw new TypeError('Permission 请求缺少 Tool 名称');
  for (const target of request.intent.targets ?? []) {
    if (!target.path.trim()) throw new TypeError('Permission 路径目标不能为空');
  }
}

function resolveTargetPaths(
  candidate: string,
  context: PermissionContext,
): readonly string[] {
  const isHomeRelative = candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\');
  if (!path.isAbsolute(candidate) && !isHomeRelative) {
    if (!context.workspaceRoot) {
      throw new TypeError(`没有工作区时不能批准相对路径：${candidate}`);
    }
    return getPathsForPermissionCheck(path.resolve(context.workspaceRoot, candidate));
  }
  return getPathsForPermissionCheck(candidate);
}


function flattenResolvedPaths(targets: readonly ResolvedPermissionTarget[]): readonly string[] {
  return targets.flatMap(target => target.resolvedPaths);
}

function findFirstMatchingRule(
  rules: PermissionRule[],
  action: 'deny' | 'ask',
  toolId: string,
  targetPaths: readonly string[],
  context: PermissionContext,
): PermissionRule | undefined {
  const find = action === 'deny' ? findDenyRule : findAskRule;
  for (const targetPath of targetPaths.length > 0 ? targetPaths : [undefined]) {
    const rule = find(rules, toolId, targetPath, context);
    if (rule) return rule;
  }
  return undefined;
}

function findAllowRulesCoveringAll(
  rules: PermissionRule[],
  toolId: string,
  targetPaths: readonly string[],
  context: PermissionContext,
): readonly PermissionRule[] | undefined {
  if (targetPaths.length === 0) {
    const rule = findAllowRule(rules, toolId, undefined, context);
    return rule ? [rule] : undefined;
  }

  const matchedRules = new Set<PermissionRule>();
  const covered = targetPaths.every(targetPath => {
    const rule = findAllowRule(rules, toolId, targetPath, context);
    if (rule) matchedRules.add(rule);
    return rule !== undefined;
  });
  return covered ? [...matchedRules] : undefined;
}

function isGrantedInternalTarget(
  target: ResolvedPermissionTarget,
  context: PermissionContext,
): boolean {
  return target.resolvedPaths.every(targetPath => {
    return target.accessType === 'read'
      ? checkReadableInternalPath(targetPath, context) === 'allow'
      : checkEditableInternalPath(targetPath, context) === 'allow';
  });
}

function isWorkspaceRead(
  targets: readonly ResolvedPermissionTarget[],
  context: PermissionContext,
): boolean {
  if (!context.workspaceRoot || targets.length === 0) return false;
  return targets.every(target =>
    target.accessType === 'read'
    && target.resolvedPaths.every(targetPath => pathInWorkingDir(targetPath, context.workspaceRoot!)),
  );
}

function isWorkspaceEdit(
  accessType: PermissionRequest['intent']['accessType'],
  targets: readonly ResolvedPermissionTarget[],
  context: PermissionContext,
): boolean {
  if (accessType !== 'write' || !context.workspaceRoot || targets.length === 0) return false;
  return targets.every(target =>
    target.accessType === 'write'
    && target.resolvedPaths.every(targetPath => pathInWorkingDir(targetPath, context.workspaceRoot!)),
  );
}

function firstDangerousTargetReason(
  targets: readonly ResolvedPermissionTarget[],
): string | undefined {
  for (const target of targets) {
    for (const targetPath of target.resolvedPaths) {
      const reason = getDangerousPathReason(targetPath);
      if (reason) return reason;
    }
  }
  return undefined;
}

function normalizeRule(rule: PermissionRule): PermissionRule {
  if (!rule.tool.trim()) throw new TypeError('Permission Rule 缺少 Tool id');
  if (rule.scope === 'workspace') {
    if (!rule.workspaceRoot || !path.isAbsolute(rule.workspaceRoot)) {
      throw new TypeError('workspace Permission Rule 必须绑定绝对工作区路径');
    }
    return { ...rule, workspaceRoot: path.resolve(rule.workspaceRoot) };
  }
  return { ...rule, workspaceRoot: rule.workspaceRoot ? path.resolve(rule.workspaceRoot) : undefined };
}

function allow(reason: PermissionDecision['reason']): PermissionDecision {
  return { outcome: 'allow', reason };
}

function deny(
  message: string,
  reason: PermissionDecision['reason'],
): PermissionDecision {
  return { outcome: 'deny', message, reason };
}
