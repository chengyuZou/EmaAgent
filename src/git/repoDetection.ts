import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 从 startDir 向上找最近可访问的 .git, 找不到时返回 null.
 * worktree 和子模块的 .git 可以是指针文件, 因此只检查是否可访问.
 * 只选出查询目录, 仓库是否可读由后续 Git 命令判断.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  for (;;) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch {
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
