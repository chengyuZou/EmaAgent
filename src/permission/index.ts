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
export { pathInWorkingDir, pathInAnyWorkingDir }      from './paths/workspaceBoundary.js';
export {
  checkEditableInternalPath, checkReadableInternalPath,
}                                                      from './paths/internalPaths.js';

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
