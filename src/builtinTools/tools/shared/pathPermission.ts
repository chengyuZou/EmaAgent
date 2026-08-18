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
  type PermissionDecision,
  type ToolPermissionContext,
} from '@ema-agent/permission';

/** 共享判定的输入：Tool 提取出绝对路径后传入。 */
export interface PathPermissionInput {
  readonly toolName: string;
  /** 候选绝对路径（Tool 已按工作区解析）。 */
  readonly path: string;
  readonly workspaceRoot?: string;
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
): PermissionDecision {
  const { toolName, path, workspaceRoot, permissionContext, internalRoots } = input;
  // 原路径与 symlink 真实路径都必须通过全部检查（防符号链接逃逸）。
  const pathsToCheck = getPathsForPermissionCheck(path);

  // 1. UNC 路径早拦（纵深防御）：可能访问网络资源。
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: `读取 ${path} 需要确认：UNC 路径可能访问网络资源`,
        decisionReason: { type: 'other', reason: 'UNC 路径（纵深防御检查）' },
      };
    }
  }

  // 2. 可疑 Windows 路径模式（ADS/短名/长前缀/连续点）：必须人工确认。
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

  // 3. read 专属 deny 规则（先于一切放行，防绕过显式拒绝）。
  for (const pathToCheck of pathsToCheck) {
    const denyRule = findMatchingContentRule(
      permissionContext, toolName, 'deny',
      (content) => matchPathRule(content, pathToCheck, workspaceRoot),
    );
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `已禁止读取 ${path}`,
        decisionReason: { type: 'rule', rule: denyRule },
      };
    }
  }

  // 4. read 专属 ask 规则。
  for (const pathToCheck of pathsToCheck) {
    const askRule = findMatchingContentRule(
      permissionContext, toolName, 'ask',
      (content) => matchPathRule(content, pathToCheck, workspaceRoot),
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `读取 ${path} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
      };
    }
  }

  // 5. 编辑权限蕴含读取权限：可写路径也可读（须在 read 专属规则之后）。
  const editResult = checkWritePathPermission(input);
  if (editResult.behavior === 'allow') return editResult;

  // 6. 工作区内读取默认放行（default 模式）。
  if (pathInAnyWorkingDir(path, { workspaceRoot })) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode: 'default' },
    };
  }

  // 7. 内部目录（宿主授予的 scratchpad 等）放行。
  if (internalReadAllow(path, internalRoots)) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'other', reason: '内部工作目录' },
    };
  }

  // 8. allow 规则。
  const allowRule = findMatchingContentRule(
    permissionContext, toolName, 'allow',
    (content) => matchPathRule(content, path, workspaceRoot),
  );
  if (allowRule) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: allowRule },
    };
  }

  // 9. 默认询问（路径在工作区之外）。
  return {
    behavior: 'ask',
    message: `读取 ${path} 需要用户确认`,
    decisionReason: { type: 'workingDir', reason: '路径在工作区之外' },
  };
}

/** 写入权限：固定检查顺序。 */
export function checkWritePathPermission(
  input: PathPermissionInput,
): PermissionDecision {
  const { toolName, path, workspaceRoot, permissionContext, internalRoots } = input;
  // 原路径与 symlink 真实路径都必须通过 deny 规则。
  const pathsToCheck = getPathsForPermissionCheck(path);

  // 1. deny 规则。
  for (const pathToCheck of pathsToCheck) {
    const denyRule = findMatchingContentRule(
      permissionContext, toolName, 'deny',
      (content) => matchPathRule(content, pathToCheck, workspaceRoot),
    );
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `已禁止写入 ${path}`,
        decisionReason: { type: 'rule', rule: denyRule },
      };
    }
  }

  // 2. 内部可编辑目录（宿主授予的 scratchpad 等）直接放行。
  if (internalWriteAllow(path, internalRoots)) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'other', reason: '内部工作目录' },
    };
  }

  // 3. 安全路径检查（UNC / 可疑 Windows 模式 / 危险文件与目录）：
  //    先于 allow 规则与 acceptEdits，防止意外授权凭据、配置与可执行任务。
  const safetyIssue = checkWriteSafety(path, pathsToCheck);
  if (safetyIssue) {
    return {
      behavior: 'ask',
      message: `写入 ${path} 需要确认：${safetyIssue}`,
      decisionReason: { type: 'safetyCheck', reason: safetyIssue },
    };
  }

  // 4. ask 规则。
  for (const pathToCheck of pathsToCheck) {
    const askRule = findMatchingContentRule(
      permissionContext, toolName, 'ask',
      (content) => matchPathRule(content, pathToCheck, workspaceRoot),
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `写入 ${path} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
      };
    }
  }

  // 5. acceptEdits 模式：工作区内写入放行（模式是 Tool 侧语义）。
  if (
    permissionContext.mode === 'acceptEdits'
    && pathInAnyWorkingDir(path, { workspaceRoot })
  ) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode: 'acceptEdits' },
    };
  }

  // 6. allow 规则。
  const allowRule = findMatchingContentRule(
    permissionContext, toolName, 'allow',
    (content) => matchPathRule(content, path, workspaceRoot),
  );
  if (allowRule) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: allowRule },
    };
  }

  // 7. 默认询问。
  return {
    behavior: 'ask',
    message: `写入 ${path} 需要用户确认`,
    ...(pathInAnyWorkingDir(path, { workspaceRoot })
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
  if (fileName) {
    for (const dangerousFile of DANGEROUS_FILES) {
      if (dangerousFile.toLowerCase() === fileName) {
        return `目标文件 ${fileName} 属于受保护文件`;
      }
    }
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
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
