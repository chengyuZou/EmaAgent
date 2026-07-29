// 上传即落盘：把原文复制进 KB 自包含目录，任务与文档记录只引用副本。
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface StagedFile {
  /** Worker 实际读取的绝对路径。 */
  absolutePath: string;
  /** asset.filePath 使用的 KB 相对路径（POSIX 分隔符，跨平台一致）。 */
  relativePath: string;
}

/**
 * 把用户提交的原文复制到 {kbRoot}/files/{assetId}/ 下。
 * 复制失败（源不可读、磁盘错误）直接抛错，调用方不应继续入队。
 */
export async function stageIngestFile(
  kbRoot: string,
  assetId: string,
  sourcePath: string,
): Promise<StagedFile> {
  const fileName = sanitizeStagedFileName(path.basename(sourcePath));
  const dir = path.join(kbRoot, 'files', assetId);
  await fs.mkdir(dir, { recursive: true });
  const absolutePath = path.join(dir, fileName);
  await fs.copyFile(sourcePath, absolutePath);
  return {
    absolutePath,
    relativePath: stagedRelativePathFor(assetId, fileName),
  };
}

/** 按 staging 目录约定推导 KB 相对路径，供任务恢复后重建同一引用。 */
export function stagedRelativePathFor(assetId: string, fileName: string): string {
  return ['files', assetId, fileName].join('/');
}

/** 删除某个文档的 staged 目录；目录不存在时静默成功。 */
export async function removeStagedAssetFiles(kbRoot: string, assetId: string): Promise<void> {
  await fs.rm(path.join(kbRoot, 'files', assetId), { recursive: true, force: true });
}

/** staged 文件名只允许单层安全文件名，杜绝路径穿越与 Windows 保留名。 */
function sanitizeStagedFileName(name: string): string {
  let cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  // Windows 不允许结尾点或空格。
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (!cleaned) return 'document';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..+)?$/i.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}
