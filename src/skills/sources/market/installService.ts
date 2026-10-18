import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertPortableRelativePath } from '../../paths.js';
import { STAGING_PREFIX, type SkillStore } from '../../store.js';
import { readMarketMeta, type MarketService } from './marketService.js';
import {
  MARKET_ERROR_CODES,
  MARKET_LIMITS,
  MARKET_META_FILENAME,
  MarketUpstreamError,
  marketSkillId,
  sanitizeDirName,
  type MarketMeta,
  type MarketSource,
} from './types.js';

export interface MarketInstallerDeps {
  readonly store: Pick<SkillStore, 'finalizeInstall' | 'deleteUserSkill'>;
  readonly userRoot: string;
  readonly market: Pick<MarketService, 'detail' | 'adapterFor'>;
}

export interface MarketInstallResult {
  readonly path: string;
  readonly dirName: string;
  readonly name: string;
  readonly version?: string;
}

export class MarketInstallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 422,
  ) {
    super(message);
    this.name = 'MarketInstallError';
  }
}

// 同一来源和 slug 同时只允许一个安装, 其他技能仍可并发下载.
const inFlight = new Map<string, Promise<unknown>>();

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function toInstallerError(error: unknown): MarketInstallError {
  if (error instanceof MarketInstallError) return error;
  if (error instanceof MarketUpstreamError) {
    return new MarketInstallError(error.code, error.message, 502);
  }
  return new MarketInstallError(MARKET_ERROR_CODES.upstreamError, error instanceof Error ? error.message : String(error));
}

export function createMarketInstaller(deps: MarketInstallerDeps) {
  async function install(source: MarketSource, slug: string): Promise<MarketInstallResult> {
    const id = marketSkillId(source, slug);
    if (inFlight.has(id)) {
      throw new MarketInstallError(MARKET_ERROR_CODES.installInProgress, `${id} 正在安装中`, 409);
    }
    const task = performInstall(source, slug);
    inFlight.set(id, task.catch(() => {}));
    try {
      return await task;
    } finally {
      inFlight.delete(id);
    }
  }

  async function performInstall(source: MarketSource, slug: string): Promise<MarketInstallResult> {
    const dirName = sanitizeDirName(slug);
    if (!dirName) {
      throw new MarketInstallError(MARKET_ERROR_CODES.notInstallable, `skill slug 不能作为目录名: ${slug}`);
    }

    let detail;
    try {
      detail = (await deps.market.detail(source, slug)).skill;
    } catch (error) {
      throw toInstallerError(error);
    }
    if (detail.installState === 'installed') {
      throw new MarketInstallError(MARKET_ERROR_CODES.alreadyInstalled, `技能已安装: ${slug}`, 409);
    }
    if (detail.installState === 'not-installable') {
      throw new MarketInstallError(
        MARKET_ERROR_CODES.notInstallable,
        `技能不可安装 (${detail.notInstallableReason}): ${slug}`,
      );
    }

    // 详情可能来自缓存, 安装前重新读取文件清单并检查下载限制.
    let files;
    try {
      files = await deps.market.adapterFor(source).listFiles(slug, detail.version);
    } catch (error) {
      throw toInstallerError(error);
    }
    if (!files.length || !files.some((f) => f.path === 'SKILL.md')) {
      throw new MarketInstallError(MARKET_ERROR_CODES.notInstallable, `技能没有可安装文件: ${slug}`);
    }
    if (files.length > MARKET_LIMITS.maxFileCount) {
      throw new MarketInstallError(MARKET_ERROR_CODES.notInstallable, `技能文件数超限: ${slug}`);
    }
    if (files.some((f) => f.size > MARKET_LIMITS.maxFileSize)
      || files.reduce((sum, f) => sum + (f.size || 0), 0) > MARKET_LIMITS.maxTotalSize) {
      throw new MarketInstallError(MARKET_ERROR_CODES.notInstallable, `技能文件体积超限: ${slug}`);
    }

    // 临时目录放在 userRoot 中, 最后 rename 时保持在同一个文件系统内.
    const staging = await mkdtemp(join(deps.userRoot, `${STAGING_PREFIX}${source}-`));
    try {
      let actualTotalSize = 0;
      for (const file of files) {
        let fetched;
        try {
          assertPortableRelativePath(file.path);
        } catch (error) {
          throw new MarketInstallError(
            MARKET_ERROR_CODES.notInstallable,
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          fetched = await deps.market.adapterFor(source).fetchFile(slug, file.path);
        } catch (error) {
          throw toInstallerError(error);
        }
        if (fetched.size > MARKET_LIMITS.maxFileSize) {
          throw new MarketInstallError(MARKET_ERROR_CODES.notInstallable, `文件超过体积上限: ${file.path}`);
        }
        actualTotalSize += fetched.size;
        if (actualTotalSize > MARKET_LIMITS.maxTotalSize) {
          throw new MarketInstallError(MARKET_ERROR_CODES.notInstallable, `技能总体积超限: ${slug}`);
        }
        if (file.sha256 && sha256Hex(fetched.content) !== file.sha256.toLowerCase()) {
          throw new MarketInstallError(MARKET_ERROR_CODES.checksumMismatch, `校验和不符,安装中止: ${file.path}`, 502);
        }
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, fetched.content, 'utf-8');
      }

      const meta: MarketMeta = {
        id: marketSkillId(source, slug),
        source,
        slug,
      };
      await writeFile(join(staging, MARKET_META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');

      const descriptor = await deps.store.finalizeInstall(staging, dirName);
      return {
        path: descriptor.path,
        dirName,
        name: descriptor.name,
        ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 安装标记必须与来源和 slug 一致, 防止按同名目录删除手动放入的技能. */
  async function uninstall(source: MarketSource, slug: string): Promise<void> {
    const dirName = sanitizeDirName(slug);
    if (!dirName) {
      throw new MarketInstallError(MARKET_ERROR_CODES.notInstalled, `非法 skill slug: ${slug}`, 400);
    }
    const dir = join(deps.userRoot, dirName);
    const meta = await readMarketMeta(dir);
    if (!meta || meta.id !== marketSkillId(source, slug)) {
      throw new MarketInstallError(MARKET_ERROR_CODES.notManaged, `该目录不是从市场安装的: ${dirName}`, 409);
    }
    await deps.store.deleteUserSkill(join(dir, 'SKILL.md'));
  }

  return { install, uninstall };
}

export type MarketInstaller = ReturnType<typeof createMarketInstaller>;
