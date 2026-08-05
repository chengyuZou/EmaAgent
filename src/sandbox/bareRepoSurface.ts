// bare-repo 文件面单点维护: 检测签名、攻击落点、只读叠加全部从这一张表投影。
// 两处消费: CommandRunner.cleanup(执行后防御)与 buildSandboxConfig(构造期只读叠加)。

import { statSync } from 'node:fs';
import path from 'node:path';

/** 完整 bare-repo 签名: 三者同时存在才构成"工作区变成了 Git 仓库"。 */
export const BARE_REPO_SIGNATURE = ['HEAD', 'objects', 'refs'] as const;

/** 攻击真正利用的落点: Git 会读取并执行/采信它们。 */
export const BARE_REPO_EXPLOIT_FILES = ['hooks', 'config'] as const;

/** 签名 ∪ 落点: 构造期已存在于工作区根的文件叠只读。 */
export const BARE_REPO_FILES: readonly string[] = [
  ...BARE_REPO_SIGNATURE,
  ...BARE_REPO_EXPLOIT_FILES,
];

/** 工作区根是否同时存在 HEAD + objects + refs(bare-repo 签名)。 */
export function hasBareRepoSignature(root: string): boolean {
  return BARE_REPO_SIGNATURE.every((fileName) => {
    try {
      statSync(path.join(root, fileName));
      return true;
    } catch {
      return false;
    }
  });
}
