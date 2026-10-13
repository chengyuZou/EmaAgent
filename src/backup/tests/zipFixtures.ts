import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { Open } from 'unzipper';

export async function writeZip(
  filePath: string,
  entries: ReadonlyMap<string, Buffer | string>,
  forceZip64 = false,
): Promise<void> {
  const archive = new ZipArchive({ forceZip64 });
  const written = pipeline(archive, fs.createWriteStream(filePath));
  for (const [name, content] of entries) {
    archive.append(content, { name });
  }
  await Promise.all([archive.finalize(), written]);
}

// 小型测试归档需要修改条目来构造坏数据; 正式导入不使用 buffer().
export async function readZip(filePath: string): Promise<Map<string, Buffer>> {
  const archive = await Open.file(filePath);
  const entries = new Map<string, Buffer>();
  for (const file of archive.files) {
    if (file.type !== 'Directory') {
      entries.set(file.path, await file.buffer());
    }
  }
  return entries;
}
