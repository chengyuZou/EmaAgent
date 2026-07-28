// 这是 Permission 包的统一出口，外部代码从这里使用它的功能和类型。

export { PermissionEngine }                           from './permissionEngine.js';
export { getPlatform, resetPlatformCache }            from './paths/platformPaths.js';
export {
  checkPathSafety, getDangerousPathReason, isDangerousRemovalPath,
  hasSuspiciousWindowsPath, hasShellExpansion,
  getPathsForPermissionCheck, normalizeCaseForComparison, normalizeMacOsSymlinks,
  DANGEROUS_FILES, DANGEROUS_DIRS,
}                                                      from './paths/pathSafety.js';
export { ruleMatches, findAllowRule, findDenyRule, findAskRule, upsertRule, clearIgnoreCache } from './policy/permissionRules.js';
export { InMemoryPermissionRuleStore }                from './policy/permissionRuleStore.js';
export type { PermissionRuleStore }                    from './policy/permissionRuleStore.js';
export { SqlPermissionRuleStore }                      from './policy/sqlPermissionRuleStore.js';
export { pathInWorkingDir, pathInAnyWorkingDir }      from './paths/workspaceBoundary.js';
export {
  DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  MAX_PERMISSION_ASK_TIMEOUT_MS,
  MIN_PERMISSION_ASK_TIMEOUT_MS,
  permissionAskTimeoutSetting,
}                                                      from './settings.js';
export {
  checkEditableInternalPath, checkReadableInternalPath,
}                                                      from './paths/internalPaths.js';

export type {
  Platform,
  PermissionMode,
  PermissionConfig,
  PermissionRule,
  PersistedPermissionRule,
  PermissionOutcome,
  PermissionPrompt,
  PendingPermissionPrompt,
  PermissionResponse,
  PermissionContext,
  AskPermissionFn,
  ToolPermissionMeta,
  DecisionReason,
  RuleScope,
  RiskLevel,
  AccessType,
  InternalPathCapabilities,
  InternalPathCapability,
}                                                      from './types.js';

export type {
  PermissionRequiredEvent,
  PermissionResolvedEvent,
  PermissionStreamEvent,
}                                                      from './events.js';
