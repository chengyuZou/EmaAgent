// zip 解压:魔数检查、路径只允许安全组件、顶层目录剥离。
// zip 内目录名不可信——本模块只产出"安全相对路径 → 字节"表,落盘名由安装方给。
import { Unzip, UnzipInflate } from 'fflate';
import { SkillPathError } from '../errors.js';
import { assertPortableRelativePath } from '../paths.js';

export interface ExtractedBundle {
  /** 安全相对路径(POSIX)→ 内容;已剥离可选顶层目录。 */
  readonly files: Readonly<Record<string, Uint8Array>>;
}

const ZIP_MAGIC_LOCAL = 0x04034b50;   // PK\x03\x04
const ZIP_MAGIC_EMPTY = 0x05064b50;   // PK\x05\x06(空包)

export function extractBundle(zipBytes: Uint8Array): ExtractedBundle {
  assertZipMagic(zipBytes);

  const files: Record<string, Uint8Array> = {};
  let failure: Error | null = null;

  const unzip = new Unzip((file) => {
    if (failure) return;
    try {
      // 目录条目不收集。
      if (file.name.endsWith('/')) return;

      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error) {
          failure = new SkillPathError(`技能包条目损坏: ${file.name}`);
          return;
        }
        entryBytes += chunk.byteLength;
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
  return finalizeBundle(stripped);
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
): ExtractedBundle {
  for (const name of Object.keys(files)) {
    assertPortableRelativePath(name, { allowSkillMd: true });
  }
  if (!Object.keys(files).some((name) => name.toLowerCase() === 'skill.md')) {
    throw new SkillPathError('技能包缺少 SKILL.md');
  }
  return { files };
}
