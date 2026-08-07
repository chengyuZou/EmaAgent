// zip 解压防护:魔数、路径只允许安全组件、条目数与总字节中途限额、顶层目录剥离。
// zip 内目录名不可信——本模块只产出"安全相对路径 → 字节"表,落盘名由安装方给。
// 与 backup 导入同款的流式 Unzip:边解压边计数,zip bomb 在超限当片中止,
// 不会先展开到内存再检查。
import { Unzip, UnzipInflate } from 'fflate';
import { SkillPathError } from '../errors.js';
import { assertPortableRelativePath } from '../paths.js';
import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_BUNDLE_FILES,
} from '../types.js';

export interface ExtractedBundle {
  /** 安全相对路径(POSIX)→ 内容;已剥离可选顶层目录。 */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly totalBytes: number;
}

const ZIP_MAGIC_LOCAL = 0x04034b50;   // PK\x03\x04
const ZIP_MAGIC_EMPTY = 0x05064b50;   // PK\x05\x06(空包)

export function extractBundle(zipBytes: Uint8Array): ExtractedBundle {
  assertZipMagic(zipBytes);

  const files: Record<string, Uint8Array> = {};
  let entryCount = 0;
  let totalBytes = 0;
  let failure: Error | null = null;

  const unzip = new Unzip((file) => {
    if (failure) return;
    try {
      // 目录条目不占名额也不收集。
      if (file.name.endsWith('/')) return;
      entryCount += 1;
      if (entryCount > MAX_SKILL_BUNDLE_FILES) {
        throw new SkillPathError(`技能包文件数超过上限(${MAX_SKILL_BUNDLE_FILES})`);
      }
      // 头部声明的解压尺寸可预检;真实尺寸在 ondata 里逐片中止。
      if (file.originalSize !== undefined && file.originalSize > MAX_SKILL_BUNDLE_BYTES) {
        throw new SkillPathError(`技能包条目过大: ${file.name}`);
      }

      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error) {
          failure = new SkillPathError(`技能包条目损坏: ${file.name}`);
          return;
        }
        entryBytes += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
          failure = new SkillPathError(
            `技能包解压总字节超过上限(${MAX_SKILL_BUNDLE_BYTES})`,
          );
          return;
        }
        chunks.push(chunk);
        if (final) {
          const merged = new Uint8Array(entryBytes);
          let offset = 0;
          for (const part of chunks) {
            merged.set(part, offset);
            offset += part.byteLength;
          }
          files[file.name] = merged;
        }
      };
      file.start();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  });
  unzip.register(UnzipInflate);
  unzip.push(zipBytes, true);

  if (failure) throw failure;

  const stripped = stripTopLevelDirectory(files);
  return finalizeBundle(stripped, totalBytes);
}

function assertZipMagic(zipBytes: Uint8Array): void {
  if (zipBytes.byteLength < 4) throw new SkillPathError('技能包不是合法的 zip(过短)');
  const magic = (zipBytes[3]! << 24) | (zipBytes[2]! << 16) | (zipBytes[1]! << 8) | zipBytes[0]!;
  if (magic !== ZIP_MAGIC_LOCAL && magic !== ZIP_MAGIC_EMPTY) {
    throw new SkillPathError('技能包不是合法的 zip(魔数不匹配)');
  }
}

/**
 * 允许一个顶层目录(剥离)或直接内容根。
 * 全部条目同嵌一个顶层段 → 剥离;其余一律按内容根处理,
 * 是否合法由 finalize 的"根必须有 SKILL.md"裁决。
 */
function stripTopLevelDirectory(
  files: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  const names = Object.keys(files);
  if (names.length === 0) throw new SkillPathError('技能包为空');

  const firstSegments = new Set(names.map((name) => name.split('/')[0]!));
  const allNested = names.every((name) => name.includes('/'));
  if (firstSegments.size === 1 && allNested) {
    const prefix = firstSegments.values().next().value! + '/';
    const stripped: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(files)) {
      stripped[name.slice(prefix.length)] = content;
    }
    return stripped;
  }
  return files;
}

function finalizeBundle(
  files: Record<string, Uint8Array>,
  totalBytes: number,
): ExtractedBundle {
  for (const name of Object.keys(files)) {
    assertPortableRelativePath(name, { allowSkillMd: true });
  }
  if (!Object.keys(files).some((name) => name.toLowerCase() === 'skill.md')) {
    throw new SkillPathError('技能包缺少 SKILL.md');
  }
  return { files, totalBytes };
}
