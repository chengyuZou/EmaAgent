// 纯 fs 的祖先 .git 走查:不启动 git 进程即可快速判断目录是否位于仓库内,与 codex 的检测顺序一致。
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 从 startDir 向上查找包含 .git 的目录,返回该目录(即仓库根);找不到返回 null。
 * .git 可能是目录,也可能是 worktree/submodule 的指针文件,两者都算仓库。
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  for (;;) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch {
      // 本层没有 .git,继续向上。
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
