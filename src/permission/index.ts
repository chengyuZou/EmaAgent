export * from './types.js';
export * from './events.js';
export { checkToolPermission } from './checkToolPermission.js';
export {
  escapeRuleContent,
  unescapeRuleContent,
  parsePermissionRuleKey,
  formatPermissionRuleKey,
  matchesWholeTool,
} from './rules/permissionRuleParser.js';
export { loadPermissionRules, reconcileProjectRules } from './rules/loader.js';
export { rememberSessionApproval, getSessionApprovals, clearSessionApprovals } from './rules/sessionApprovals.js';
export {
  matchShellRule,
  matchWildcardPattern,
  parsePermissionRule,
  shellCommandToRuleContent,
  type ShellPermissionRule,
} from './checks/shell/shellRuleMatching.js';
export { directoryPathToRuleContent, filePathToRuleContent, matchPathRule } from './checks/file/pathRuleMatching.js';
export {
  DANGEROUS_FILES,
  getPathsForPermissionCheck,
  hasSuspiciousWindowsPath,
  normalizeCaseForComparison,
  normalizeMacOsSymlinks,
} from './checks/file/pathSafety.js';
export { pathInAnyWorkingDir, pathInWorkingDir } from './checks/file/workspaceBoundary.js';
export { getPlatform, resetPlatformCache, toPortablePath, type Platform } from './checks/file/platformPaths.js';
export {
  DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  MAX_PERMISSION_ASK_TIMEOUT_MS,
  MIN_PERMISSION_ASK_TIMEOUT_MS,
  PERMISSION_SETTINGS,
  permissionAskTimeoutSetting,
  permissionRulesProjectAllowSetting,
  permissionRulesProjectAskSetting,
  permissionRulesProjectDenySetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserAskSetting,
  permissionRulesUserDenySetting,
} from './settings.js';
