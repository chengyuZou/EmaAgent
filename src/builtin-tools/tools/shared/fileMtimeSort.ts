// 为文件搜索工具按修改时间稳定排序，并把扫描期间消失的文件安全排到末尾。
import fs from 'node:fs/promises';

interface FileMtimeEntry {
  path: string;
  mtimeMs: number;
}

/** 按 mtime 降序排序；相同时间按路径决胜，stat 失败的文件排到末尾。 */
export async function sortPathsByMtimeDesc(
  paths: readonly string[],
): Promise<string[]> {
  const settled = await Promise.allSettled(
    paths.map(async (filePath): Promise<FileMtimeEntry> => {
      const stat = await fs.stat(filePath);
      return { path: filePath, mtimeMs: stat.mtimeMs };
    }),
  );

  const entries = settled.map((result, index): FileMtimeEntry => (
    result.status === 'fulfilled'
      ? result.value
      : { path: paths[index]!, mtimeMs: 0 }
  ));
  entries.sort((left, right) => (
    right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
  ));
  return entries.map(entry => entry.path);
}
