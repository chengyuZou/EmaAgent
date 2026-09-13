// SkillRegistry:活注册表,持有全量技能的当前事实(镜像 ToolRegistry)。
// 不产出中间 snapshot——冻结只发生在 SkillPool(镜像 ToolPool)。
//
// 装载模型：
// - builtin + user 与工作区无关，合并为 core；启动时、安装/卸载后由 refreshCore() 重扫；
// - project 技能按源文件夹清单首次读取并缓存,显式 refreshProjectFolders() 时重扫。
import type { SkillStore } from './sources/user.js';
import { scanBuiltinSkills } from './sources/builtin.js';
import { scanProjectSkills } from './sources/project.js';
import type { SkillDescriptor } from './types.js';

export interface SkillRegistryDeps {
  /** user 技能根(<profileDir>/skills)。 */
  readonly userRoot: string;
  /** 内置技能目录(<profileDir>/resources/skills,由宿主在启动时铺好,只读)。 */
  readonly builtinRoot: string;
  readonly store: SkillStore;
}

export interface SkillRegistry {
  /** builtin+user 重扫；串行接棒,并发调用不交错。启动、安装、卸载后调用。 */
  refreshCore(): Promise<void>;
  /** 重扫当前文件夹清单的 project 技能并替换该清单缓存。 */
  refreshProjectFolders(folderPaths: readonly string[]): Promise<void>;
  /**
   * 当前全量(含禁用项);禁用过滤是 Pool 冻结时的事。
   * 传入源文件夹清单时附带对应的 project 技能；首次读取会扫描。
   * 调用会等待进行中的首次 core 装载，避免启动竞态下读到空目录。
   */
  list(folderPaths?: readonly string[]): Promise<readonly SkillDescriptor[]>;
  getByPath(path: string, folderPaths?: readonly string[]): Promise<SkillDescriptor | undefined>;
}

/**
 * core 刷新流程:builtin 直扫 + user 对账 → 合成 core 全量。
 * 任一来源失败只降级该来源(空数组 + warning),不拖垮整轮刷新。
 */
export function createSkillRegistry(deps: SkillRegistryDeps): SkillRegistry {
  let core: readonly SkillDescriptor[] = [];
  const coreByPath = new Map<string, SkillDescriptor>();
  const projectByFolders = new Map<string, readonly SkillDescriptor[]>();
  let coreReady: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  async function scanCore(): Promise<void> {
    const [builtin, user] = await Promise.all([
      scanBuiltinSkills({
        builtinRoot: deps.builtinRoot,
      }).catch(() => [] as SkillDescriptor[]),
      deps.store.reconcileUserRoot()
        .then((result) => result.entries)
        .catch(() => [] as SkillDescriptor[]),
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
    // 首次装载尚未完成时等待它，而不是把空目录交给调用方；首装失败降级为当前 core。
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
