// 这是 Permission 包的统一出口，外部代码从这里使用它的功能和类型。

export { PermissionEngine }                           from './checker.js';
export { getPlatform, resetPlatformCache }            from './platform.js';
export {
  checkPathSafety, getDangerousPathReason, isDangerousRemovalPath,
  hasSuspiciousWindowsPath, hasShellExpansion,
  getPathsForPermissionCheck, normalizeCaseForComparison, normalizeMacOsSymlinks,
  DANGEROUS_FILES, DANGEROUS_DIRS,
}                                                      from './path-safety.js';
export { ruleMatches, findAllowRule, findDenyRule, findAskRule, upsertRule, clearIgnoreCache } from './rules.js';
export { pathInWorkingDir, pathInAnyWorkingDir }      from './workspace.js';
export {
  checkEditableInternalPath, checkReadableInternalPath,
}                                                      from './internal-paths.js';

export type {
  Platform,
  PermissionMode,
  PermissionConfig,
  PermissionRule,
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
