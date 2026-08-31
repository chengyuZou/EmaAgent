// 站点技能安装管道:下载 → 解压 → staging → 原子发布 → 索引。
// 单队列串行(三行 promise 链内嵌),不并发安装。
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SkillDescriptor } from '../types.js';
import type { SkillSiteEntry } from '../sources/sites/siteStore.js';
import type { SkillStore } from '../store.js';
import { downloadBundle, type BundleDownloadInput } from './download.js';
import { extractBundle, type ExtractedBundle } from './extract.js';
import { STAGING_PREFIX } from '../store.js';

export interface SiteInstallInput {
  readonly siteId: string;
  readonly entry: SkillSiteEntry;
}

export interface InstallDeps {
  /** 安装落位只消费 finalizeInstall；按真实消费收窄。 */
  readonly store: Pick<SkillStore, 'finalizeInstall'>;
  /** userRoot;staging 建在其中保证 rename 同卷原子。 */
  readonly userRoot: string;
  /** 测试注入的下载替身;生产默认走 downloadBundle。 */
  readonly downloader?: (input: BundleDownloadInput) => Promise<Uint8Array>;
}

/**
 * 按 installKey 串行、跨 key 并行:同一技能的两次安装绝不交错
 * (rm 目标 + rename staging 会互踩),不同技能共享状态为零,直接并行。
 */
const installTails = new Map<string, Promise<unknown>>();

export function installSkillFromSite(
  input: SiteInstallInput,
  deps: InstallDeps,
): Promise<SkillDescriptor> {
  const key = `site_${input.siteId}_${input.entry.id}`;
  const previous = installTails.get(key) ?? Promise.resolve();
  const run = previous.then(() => doInstall(input, deps));
  const tail = run.then(() => undefined, () => undefined);
  installTails.set(key, tail);
  // 链尾结算后自清,长会话里 Map 不只涨不消。
  void tail.then(() => {
    if (installTails.get(key) === tail) installTails.delete(key);
  });
  return run;
}

async function doInstall(
  input: SiteInstallInput,
  deps: InstallDeps,
): Promise<SkillDescriptor> {
  const { entry } = input;
  const bytes = await (deps.downloader ?? downloadBundle)({
    bundleUrl: entry.bundleUrl,
    bundleSha256: entry.bundleSha256,
    sizeBytes: entry.sizeBytes,
  });
  const bundle = extractBundle(bytes);

  const stagingDir = join(deps.userRoot, `${STAGING_PREFIX}${randomUUID()}`);
  await writeBundleToDisk(stagingDir, bundle);
  try {
    return await deps.store.finalizeInstall(stagingDir, {
      kind: 'site',
      siteId: input.siteId,
      siteEntryId: entry.id,
      version: entry.version,
      bundleUrl: entry.bundleUrl,
      bundleSha256: entry.bundleSha256,
    });
  } finally {
    // finalize 成功时 staging 已被 rename 走,这里是失败分支的清理;force 忽略不存在。
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** staging 写入:路径已在 extract 过校验,这里只做落盘。 */
async function writeBundleToDisk(stagingDir: string, bundle: ExtractedBundle): Promise<void> {
  await mkdir(stagingDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(bundle.files)) {
    const destination = join(stagingDir, ...relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
