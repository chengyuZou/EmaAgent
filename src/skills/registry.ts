import type { SkillStore } from './store.js';
import { scanProjectSkills } from './sources/project.js';
import type { SkillDescriptor } from './types.js';

export interface SkillRegistryDeps {
  readonly store: SkillStore;
}

export interface SkillRegistry {
  /** 启动, 安装, 删除或手动重扫时调用. 多次调用按顺序执行, 避免索引更新交错. */
  refreshCore(): Promise<void>;
  /** 重扫指定文件夹清单, 只替换该清单的 project 技能缓存. */
  refreshProjectFolders(folderPaths: readonly string[]): Promise<void>;
  /**
   * 返回包含禁用项的目录. 传入文件夹清单时附带对应 project 技能, 首次读取会扫描.
   * 宿主必须先调用 refreshCore; list 会等待首次装载, 但不会等待后续重扫.
   */
  list(folderPaths?: readonly string[]): Promise<readonly SkillDescriptor[]>;
  getByPath(path: string, folderPaths?: readonly string[]): Promise<SkillDescriptor | undefined>;
}

export function createSkillRegistry(deps: SkillRegistryDeps): SkillRegistry {
  let core: readonly SkillDescriptor[] = [];
  const coreByPath = new Map<string, SkillDescriptor>();
  const projectByFolders = new Map<string, readonly SkillDescriptor[]>();
  let coreReady: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  async function scanCore(): Promise<void> {
    const [builtin, user] = await Promise.all([
      deps.store.reconcileBuiltinRoot()
        .catch(error => {
          console.warn('[skills] builtin 对账失败:', error);
          return [] as SkillDescriptor[];
        }),
      deps.store.reconcileUserRoot()
        .catch(error => {
          console.warn('[skills] user 对账失败:', error);
          return [] as SkillDescriptor[];
        }),
    ]);
    core = [...builtin, ...user];
    coreByPath.clear();
    for (const entry of core) coreByPath.set(entry.path, entry);
  }

  async function scanFolders(folderPaths: readonly string[]): Promise<readonly SkillDescriptor[]> {
    try {
      return await scanProjectSkills(folderPaths);
    } catch {
      return [];
    }
  }

  async function list(folderPaths: readonly string[] = []): Promise<readonly SkillDescriptor[]> {
    // 启动装载尚未完成时等待它, 避免第一次读取拿到空目录.
    if (coreReady) await coreReady.catch(() => undefined);
    let project: readonly SkillDescriptor[] = [];
    if (folderPaths.length > 0) {
      const key = JSON.stringify(folderPaths);
      if (!projectByFolders.has(key)) await refreshProjectFolders(folderPaths);
      project = projectByFolders.get(key) ?? [];
    }
    return [...core, ...project];
  }

  async function refreshProjectFolders(folderPaths: readonly string[]): Promise<void> {
    const entries = await scanFolders(folderPaths);
    projectByFolders.set(JSON.stringify(folderPaths), entries);
  }

  return {
    refreshCore(): Promise<void> {
      const run = tail.then(scanCore);
      tail = run.then(() => undefined, () => undefined);
      coreReady ??= run;
      return run;
    },
    refreshProjectFolders,
    list,
    async getByPath(path: string, folderPaths: readonly string[] = []) {
      if (coreReady) await coreReady.catch(() => undefined);
      const coreEntry = coreByPath.get(path);
      if (coreEntry) return coreEntry;
      if (folderPaths.length === 0) return undefined;
      const entries = await list(folderPaths);
      return entries.find((entry) => entry.path === path);
    },
  };
}
