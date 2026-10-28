import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import type { FilePermissionCheck, PermissionContext } from '../../types.js';
import { exactInputCondition, type PreparedPermissionCheck } from '../preparedPermissionCheck.js';
import { DANGEROUS_FILES, getPathsForPermissionCheck, hasSuspiciousWindowsPath } from './pathSafety.js';
import { directoryPathToRuleContent, filePathToRuleContent, matchPathRule } from './pathRuleMatching.js';
import { pathInWorkingDir } from './workspaceBoundary.js';

const WRITE_PROTECTED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.ssh', '.gnupg', '.gpg',
  '.aws', '.azure', '.kube', '.ema-agent',
  '.vscode', '.idea',
]);


export function prepareFilePermission(
  toolName: string,
  check: FilePermissionCheck,
  context: PermissionContext,
  input: unknown,
): PreparedPermissionCheck {
  const isNetworkPath = check.path.startsWith('\\\\') || check.path.startsWith('//');
  // 查询网络路径本身就会访问远端, 因此批准前不解析链接或读取目标类型.
  const paths = isNetworkPath ? [check.path] : getPathsForPermissionCheck(check.path);
  let target = check.target;
  if (target === 'path' && !isNetworkPath) {
    target = fs.statSync(check.path).isDirectory() ? 'directory' : 'file';
  }
  let condition: string;
  if (isNetworkPath && target === 'path') {
    condition = exactInputCondition(input);
  } else if (target === 'directory') {
    condition = directoryPathToRuleContent(check.path);
  } else {
    condition = filePathToRuleContent(check.path);
  }

  const insideWorkspace = !isNetworkPath && paths.every(path =>
    context.workspaceRoots.some(root => pathInWorkingDir(path, root)));
  const internalDirectories = !isNetworkPath
    ? (check.internalReadDirectories ?? []).flatMap(directory => getPathsForPermissionCheck(directory))
    : [];
  const internalRead = check.operation === 'read' && internalDirectories.length > 0
    && paths.every(path => internalDirectories.some(root => pathInWorkingDir(path, root)));

  let confirmationReason: string | undefined;
  if (isNetworkPath) {
    confirmationReason = '目标是网络路径';
  } else if (paths.some(hasSuspiciousWindowsPath)) {
    confirmationReason = '目标包含特殊 Windows 路径写法';
  } else if (check.operation === 'write') {
    confirmationReason = dangerousPathReason(check.path);
  }

  let defaultDecision: 'allow' | 'ask' = 'ask';
  if (check.operation === 'read' && (insideWorkspace || internalRead)) {
    defaultDecision = 'allow';
  } else if (check.operation === 'write' && context.mode === 'acceptEdits' && insideWorkspace) {
    defaultDecision = 'allow';
  }

  const operation = check.operation === 'read' ? '读取' : '写入';
  let scopeDescription = `这个文件: ${check.path}`;
  if (target === 'directory') scopeDescription = `这个目录及其子目录: ${check.path}`;
  if (isNetworkPath && target === 'path') scopeDescription = '与本次完全相同的参数';
  return {
    defaultDecision,
    confirmation: confirmationReason ? 'required' : 'byRules',
    message: confirmationReason
      ? `允许${operation} ${check.path} 吗? ${confirmationReason}.`
      : `允许${operation} ${check.path} 吗?`,
    sessionApproval: {
      key: { toolName, condition },
      description: `本会话允许 ${toolName} 使用${scopeDescription}.`,
    },
    matchesConditions(conditions, decision) {
      if (conditions.includes(condition)) return true;
      // 拒绝和询问检查原路径及真实路径; 字面文件批准仍以请求的绝对路径为范围.
      const candidates = decision === 'allow' ? [check.path] : paths;
      return conditions.some(rule => candidates.some(path => matchPathRule(rule, path, check.cwd)));
    },
  };
}

// 凭据和配置目录的写入需要单独确认, 普通默认写入则交给权限模式处理.
function dangerousPathReason(absolutePath: string): string | undefined {
  const segments = absolutePath.split(/[\\/]/).filter(Boolean);
  const fileName = segments.at(-1)?.toLowerCase();
  const defaultWorkspace = nodePath.join(os.homedir(), '.ema-agent', 'workspace');
  const profileDirectoryIndex = defaultWorkspace.split(/[\\/]/).filter(Boolean).length - 2;
  const relativeToDefaultWorkspace = nodePath.relative(defaultWorkspace, absolutePath);
  const insideDefaultWorkspace = relativeToDefaultWorkspace === ''
    || (
      relativeToDefaultWorkspace !== '..'
      && !relativeToDefaultWorkspace.startsWith(`..${nodePath.sep}`)
      && !nodePath.isAbsolute(relativeToDefaultWorkspace)
    );
  if (fileName) {
    for (const dangerousFile of DANGEROUS_FILES) {
      if (dangerousFile.toLowerCase() === fileName) {
        return `目标文件 ${fileName} 属于受保护文件`;
      }
    }
  }
  for (const [index, segment] of segments.entries()) {
    const lower = segment.toLowerCase();
    if (lower === '.ema-agent' && insideDefaultWorkspace && index === profileDirectoryIndex) {
      continue;
    }
    for (const protectedDir of WRITE_PROTECTED_DIRS) {
      if (protectedDir.toLowerCase() === lower) {
        return `目标路径含受保护目录 ${segment}`;
      }
    }
  }
  return undefined;
}

