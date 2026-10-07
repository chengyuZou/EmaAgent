// 文件类 Tool 的共享路径权限判定：read / write 两条固定检查顺序。
// 各文件 Tool 的 checkPermissions 只负责提取路径，判定逻辑全部收敛在这里，
// 避免六个文件工具各自重复实现路径安全与规则匹配。

import {
  checkInternalPath,
  DANGEROUS_FILES,
  findMatchingContentRule,
  getPathsForPermissionCheck,
  hasSuspiciousWindowsPath,
  type InternalPathRoots,
  matchPathRule,
  pathInAnyWorkingDir,
  type PermissionResult,
  type ToolPermissionContext,
} from '@ema-agent/permission';
import os from 'node:os';
import nodePath from 'node:path';

/** 共享判定的输入：Tool 提取出绝对路径后传入。 */
export interface PathPermissionInput {
  readonly toolName: string;
  /** 候选绝对路径（Tool 已按工作区解析）。 */
  readonly path: string;
  readonly cwd?: string;
  readonly permissionContext: ToolPermissionContext;
  /** 宿主按 Turn 授予的内部工作目录（scratchpad 等），命中则直接放行。 */
  readonly internalRoots?: InternalPathRoots;
}

/** 写入需要额外拦截的敏感目录（凭据/配置/IDE/内部目录）；依赖与缓存目录不拦。 */
const WRITE_PROTECTED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.ssh', '.gnupg', '.gpg',
  '.aws', '.azure', '.kube', '.ema-agent',
  '.vscode', '.idea',
]);

/** 读取权限：固定检查顺序。 */
export function checkReadPathPermission(
  input: PathPermissionInput,
): PermissionResult {
  const { toolName, path, cwd, permissionContext, internalRoots } = input;
  // 原路径与 symlink 真实路径都必须通过全部检查（防符号链接逃逸）。
  const isNetworkPath = path.startsWith('\\\\') || path.startsWith('//');
  // 网络路径在批准前不能做 exists/realpath, 这些查询本身就会访问网络.
  const pathsToCheck = isNetworkPath ? [path] : getPathsForPermissionCheck(path);

  for (const pathToCheck of pathsToCheck) {
    const denyRule = findMatchingContentRule(
      permissionContext, toolName, 'deny',
      content => matchPathRule(content, pathToCheck, cwd),
    );
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `已禁止读取 ${path}`,
        decisionReason: { type: 'rule', rule: denyRule },
      };
    }
  }
  const sessionRule = findMatchingContentRule(
    permissionContext, toolName, 'allow',
    content => matchPathRule(content, path, cwd), 'session',
  );
  if (sessionRule) {
    return { behavior: 'allow', decisionReason: { type: 'rule', rule: sessionRule } };
  }

  // 未获会话批准的网络路径需要确认, 不在批准前访问网络.
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: `读取 ${path} 需要确认：UNC 路径可能访问网络资源`,
        decisionReason: { type: 'other', reason: 'UNC 路径（纵深防御检查）' },
      };
    }
  }

  // 可疑 Windows 路径模式需要人工确认.
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPath(pathToCheck)) {
      return {
        behavior: 'ask',
        message: `读取 ${path} 需要确认：路径含可疑的 Windows 路径模式`,
        decisionReason: {
          type: 'other',
          reason: '路径含可疑 Windows 模式（备用数据流/短名/长前缀/连续点）',
        },
      };
    }
  }

  // 未命中会话批准时检查读取询问规则.
  for (const pathToCheck of pathsToCheck) {
    const askRule = findMatchingContentRule(
      permissionContext, toolName, 'ask',
      (content) => matchPathRule(content, pathToCheck, cwd),
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `读取 ${path} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
      };
    }
  }

  // 当前工具的写入路径判定若放行, 同一路径也可以读取.
  const editResult = checkWritePathPermission(input);
  if (editResult.behavior === 'allow') return editResult;

  // 工作区内读取默认放行.
  if (pathInAnyWorkingDir(path, permissionContext)) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode: 'default' },
    };
  }

  // 宿主授予的内部目录放行.
  if (internalReadAllow(path, internalRoots)) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'other', reason: '内部工作目录' },
    };
  }

  // 用户和项目的内容允许规则.
  const allowRule = findMatchingContentRule(
    permissionContext, toolName, 'allow',
    (content) => matchPathRule(content, path, cwd),
  );
  if (allowRule) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: allowRule },
    };
  }

  // 工作区外路径默认询问.
  return {
    behavior: 'ask',
    message: `读取 ${path} 需要用户确认`,
    decisionReason: { type: 'workingDir', reason: '路径在工作区之外' },
  };
}

/** 写入权限：固定检查顺序。 */
export function checkWritePathPermission(
  input: PathPermissionInput,
): PermissionResult {
  const { toolName, path, cwd, permissionContext, internalRoots } = input;
  // 原路径与 symlink 真实路径都必须通过 deny 规则。
  const isNetworkPath = path.startsWith('\\\\') || path.startsWith('//');
  const pathsToCheck = isNetworkPath ? [path] : getPathsForPermissionCheck(path);

  // 原路径及解析后的路径都检查显式拒绝.
  for (const pathToCheck of pathsToCheck) {
    const denyRule = findMatchingContentRule(
      permissionContext, toolName, 'deny',
      (content) => matchPathRule(content, pathToCheck, cwd),
    );
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `已禁止写入 ${path}`,
        decisionReason: { type: 'rule', rule: denyRule },
      };
    }
  }

  const sessionRule = findMatchingContentRule(
    permissionContext, toolName, 'allow',
    content => matchPathRule(content, path, cwd), 'session',
  );
  if (sessionRule) {
    return { behavior: 'allow', decisionReason: { type: 'rule', rule: sessionRule } };
  }

  // 宿主授予的内部可编辑目录直接放行.
  if (internalWriteAllow(path, internalRoots)) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'other', reason: '内部工作目录' },
    };
  }

  // 未获会话批准的敏感路径先询问, 普通配置 allow 与 acceptEdits 不跳过确认.
  const safetyIssue = checkWriteSafety(path, pathsToCheck);
  if (safetyIssue) {
    return {
      behavior: 'ask',
      message: `写入 ${path} 需要确认：${safetyIssue}`,
      decisionReason: { type: 'safetyCheck', reason: safetyIssue },
    };
  }

  // 用户和项目的内容询问规则.
  for (const pathToCheck of pathsToCheck) {
    const askRule = findMatchingContentRule(
      permissionContext, toolName, 'ask',
      (content) => matchPathRule(content, pathToCheck, cwd),
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `写入 ${path} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
      };
    }
  }

  // acceptEdits 的工作区写入语义由路径工具处理.
  if (
    permissionContext.mode === 'acceptEdits'
    && pathInAnyWorkingDir(path, permissionContext)
  ) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode: 'acceptEdits' },
    };
  }

  // 用户和项目的内容允许规则.
  const allowRule = findMatchingContentRule(
    permissionContext, toolName, 'allow',
    (content) => matchPathRule(content, path, cwd),
  );
  if (allowRule) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: allowRule },
    };
  }

  // 未获得放行理由时默认询问.
  return {
    behavior: 'ask',
    message: `写入 ${path} 需要用户确认`,
    ...(pathInAnyWorkingDir(path, permissionContext)
      ? {}
      : { decisionReason: { type: 'workingDir', reason: '路径在工作区之外' } }),
  };
}

/** 写入的安全路径检查：UNC、可疑 Windows 模式、危险文件/目录（均大小写归一）。 */
function checkWriteSafety(
  path: string,
  pathsToCheck: readonly string[],
): string | undefined {
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return 'UNC 路径可能访问网络资源';
    }
    if (hasSuspiciousWindowsPath(pathToCheck)) {
      return '路径含可疑的 Windows 路径模式（备用数据流/短名/长前缀/连续点）';
    }
  }
  return dangerousPathReason(path);
}

/** 命中受保护文件或敏感目录时返回原因，否则 undefined。匹配一律转小写，防 .ENV/.Git 混合大小写绕过。 */
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

function internalReadAllow(
  absolutePath: string,
  internalRoots: InternalPathRoots | undefined,
): boolean {
  return internalRoots !== undefined
    && checkInternalPath(absolutePath, internalRoots) === 'allow';
}

function internalWriteAllow(
  absolutePath: string,
  internalRoots: InternalPathRoots | undefined,
): boolean {
  return internalRoots !== undefined
    && checkInternalPath(absolutePath, internalRoots) === 'allow';
}
