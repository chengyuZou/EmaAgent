export { PermissionEngine }                           from './checker.js';
export { getPlatform, resetPlatformCache }            from './platform.js';
export {
  checkPathSafety, getDangerousPathReason, isDangerousRemovalPath,
  hasSuspiciousWindowsPath, hasShellExpansion,
  getPathsForPermissionCheck, normalizeCaseForComparison, normalizeMacOsSymlinks,
  DANGEROUS_FILES, DANGEROUS_DIRS,
}                                                      from './path-safety.js';
export { ruleMatches, findAllowRule, findDenyRule, findAskRule, upsertRule } from './rules.js';
export { pathInWorkingDir, pathInAnyWorkingDir }      from './workspace.js';
export {
  checkEditableInternalPath, checkReadableInternalPath,
  sessionMemoryDir, artifactDir, scratchpadDir, sessionsRoot, emaHome,
}                                                      from './internal-paths.js';

export type {
  Platform,
  PermissionMode,
  PermissionConfig,
  PermissionRule,
  PermissionOutcome,
  PermissionRequest,
  PermissionResponse,
  PermissionUpdate,
  PermissionContext,
  AskPermissionFn,
  ToolPermissionMeta,
  DecisionReason,
  RuleScope,
  RiskLevel,
  AccessType,
}                                                      from './types.js';
