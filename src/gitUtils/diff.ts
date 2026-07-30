// 工作区 diff:tracked 走 git diff,untracked 逐文件 --no-index 伪 diff。
// 安全约束与 codex /diff 一致:禁 textconv/ext-diff 可执行 helper,filter driver 置空,
// submodule 只看短状态;--no-index 有差异时退出码 1 属正常。
import path from 'node:path';
import { GitError } from './errors.js';
import { runGit } from './gitProcess.js';
import { findRepoRoot } from './repoDetection.js';
import type {
  GitDiffFile,
  GitFileStatus,
  GitScopeDiff,
  GitWorkspaceDiffResult,
} from './types.js';

/** 有界上下文:给前端"增量展开"留缓冲,又不做整文件加载。 */
const DIFF_CONTEXT_LINES = 20;
const MAX_FILE_DIFF_CHARS = 200_000;
const MAX_TOTAL_DIFF_CHARS = 2_000_000;
const MAX_FILES_PER_SCOPE = 200;
const MAX_UNTRACKED_FILES = 50;
const UNTRACKED_DIFF_CONCURRENCY = 8;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
/** 合并 patch 的进程输出上限:高于总量截断,让截断逻辑而不是 maxBuffer 兜底。 */
const DIFF_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function gitWorkspaceDiff(workspaceRoot: string): Promise<GitWorkspaceDiffResult> {
  const repoRoot = await findRepoRoot(workspaceRoot);
  if (!repoRoot) return { capability: 'not-a-repo' };

  try {
    const overrides = await filterDriverOverrides(repoRoot);
    const [staged, unstaged] = await Promise.all([
      queryScopeDiff(repoRoot, overrides, 'staged'),
      queryScopeDiff(repoRoot, overrides, 'unstaged'),
    ]);
    return { capability: 'ok', repoRoot, staged, unstaged };
  } catch (error) {
    if (error instanceof GitError) {
      if (error.code === 'git/unavailable') return { capability: 'git-unavailable' };
      return { capability: 'error', message: error.stderr ?? error.message };
    }
    throw error;
  }
}

async function queryScopeDiff(
  repoRoot: string,
  overrides: readonly string[],
  scope: 'staged' | 'unstaged',
): Promise<GitScopeDiff> {
  const diffArgs = [
    ...overrides,
    'diff',
    `-U${DIFF_CONTEXT_LINES}`,
    '--no-color',
    '--no-textconv',
    '--no-ext-diff',
    '--submodule=short',
    '--ignore-submodules=dirty',
    ...(scope === 'staged' ? ['--cached'] : []),
  ];
  const { stdout } = await runGit(repoRoot, diffArgs, {
    maxOutputBytes: DIFF_PROCESS_OUTPUT_BYTES,
  });
  const sections = parseGitDiffSections(stdout);
  const files: GitDiffFile[] = [];
  let omittedFiles = 0;
  let totalChars = 0;

  for (const section of sections) {
    if (files.length >= MAX_FILES_PER_SCOPE || totalChars >= MAX_TOTAL_DIFF_CHARS) {
      omittedFiles += 1;
      continue;
    }
    files.push(toDiffFile(repoRoot, section, 'modified'));
    totalChars += files[files.length - 1]?.unifiedDiff.length ?? 0;
  }

  // 未跟踪文件只属于未暂存维度:ls-files 列清单,逐文件 --no-index 伪 diff。
  if (scope === 'unstaged') {
    const untracked = await listUntrackedFiles(repoRoot, overrides);
    const budget = Math.max(0, MAX_UNTRACKED_FILES - 0);
    const selected = untracked.slice(0, budget);
    omittedFiles += Math.max(0, untracked.length - selected.length);
    for (let i = 0; i < selected.length; i += UNTRACKED_DIFF_CONCURRENCY) {
      const batch = selected.slice(i, i + UNTRACKED_DIFF_CONCURRENCY);
      // 单个文件(超大/权限)失败只计入 omitted,不拖垮整个工作区 diff。
      const patches = await Promise.all(batch.map((file) =>
        diffUntrackedFile(repoRoot, overrides, file).catch((error: unknown) => {
          if (error instanceof GitError) return null;
          throw error;
        })));
      for (const patch of patches) {
        if (patch === null) {
          omittedFiles += 1;
          continue;
        }
        if (files.length >= MAX_FILES_PER_SCOPE || totalChars >= MAX_TOTAL_DIFF_CHARS) {
          omittedFiles += 1;
          continue;
        }
        const parsed = parseGitDiffSections(patch)[0];
        if (!parsed) continue;
        files.push(toDiffFile(repoRoot, parsed, 'added'));
        totalChars += files[files.length - 1]?.unifiedDiff.length ?? 0;
      }
    }
  }

  return {
    files,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
    omittedFiles,
  };
}

/**
 * 仓库可通过 filter.<driver>.clean/process 配置可执行 helper,diff 工作区文件时会触发;
 * 与 hooksPath=NUL 同一威胁模型,逐一查出并置空(codex 同款)。
 */
async function filterDriverOverrides(repoRoot: string): Promise<readonly string[]> {
  const { stdout } = await runGit(repoRoot, [
    'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$',
  ], { allowedExitCodes: [1] });
  const drivers = new Set<string>();
  for (const key of stdout.split('\0')) {
    const driver = key.replace(/\.(clean|process)$/, '');
    if (driver.startsWith('filter.') && driver.length > 'filter.'.length) drivers.add(driver);
  }
  return [...drivers].flatMap((driver) => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`]);
}

async function listUntrackedFiles(repoRoot: string, overrides: readonly string[]): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, [
    ...overrides, 'ls-files', '--others', '--exclude-standard',
  ]);
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

async function diffUntrackedFile(
  repoRoot: string,
  overrides: readonly string[],
  file: string,
): Promise<string> {
  const { stdout } = await runGit(repoRoot, [
    ...overrides,
    'diff', '--no-index', '--no-color', `-U${DIFF_CONTEXT_LINES}`,
    '--no-textconv', '--no-ext-diff',
    '--', NULL_DEVICE, file,
  ], { allowedExitCodes: [1], maxOutputBytes: DIFF_PROCESS_OUTPUT_BYTES });
  return stdout;
}

// ── patch 解析(纯函数,供测试)───────────────────────────────────────────────

export interface GitDiffSection {
  /** b 侧路径(删除文件时取 a 侧),POSIX 相对路径。 */
  readonly path: string;
  readonly status: GitFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

/** 把合并 patch 按 "diff --git" 头切成单文件段,并解析路径/状态/增删计数。 */
export function parseGitDiffSections(patch: string): GitDiffSection[] {
  const sections: GitDiffSection[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const parsed = parseSection(current);
    if (parsed) sections.push(parsed);
    current = [];
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return sections;
}

function parseSection(lines: readonly string[]): GitDiffSection | null {
  let newPath: string | null = null;
  let oldPath: string | null = null;
  let status: GitFileStatus = 'modified';
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith('new file mode')) status = 'added';
    else if (line.startsWith('deleted file mode')) status = 'deleted';
    else if (line.startsWith('rename from ')) status = 'renamed';
    else if (line.startsWith('+++ ')) newPath = parseMarkerPath(line.slice(4));
    else if (line.startsWith('--- ')) oldPath = parseMarkerPath(line.slice(4));
    else if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }

  const path = newPath ?? oldPath;
  if (!path) return null;
  return { path, status, additions, deletions, patch: lines.join('\n') };
}

/** 解析 ---/+++ 标记行:b/ 前缀取新侧,a/ 前缀取旧侧,/dev/null 返回 null。 */
function parseMarkerPath(raw: string): string | null {
  const value = raw.trim();
  if (value === '/dev/null') return null;
  const unprefixed = value.replace(/^[ab]\//, '');
  // git 对含特殊字符的路径整体加双引号并转义,按 JSON 字符串解码。
  if (unprefixed.startsWith('"')) {
    try {
      return JSON.parse(unprefixed) as string;
    } catch {
      return unprefixed;
    }
  }
  return unprefixed;
}

function toDiffFile(
  repoRoot: string,
  section: GitDiffSection,
  fallbackStatus: GitFileStatus,
): GitDiffFile {
  const truncated = section.patch.length > MAX_FILE_DIFF_CHARS;
  return {
    path: section.path,
    absolutePath: path.join(repoRoot, section.path),
    status: section.status === 'modified' && fallbackStatus !== 'modified'
      ? fallbackStatus
      : section.status,
    additions: section.additions,
    deletions: section.deletions,
    unifiedDiff: truncated
      ? `${section.patch.slice(0, MAX_FILE_DIFF_CHARS)}\n@@ diff 已截断 @@\n`
      : section.patch,
    truncated,
  };
}
