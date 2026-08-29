// SkillRegistry:活注册表,持有全量技能的当前事实(镜像 ToolRegistry)。
// 不产出中间 snapshot——冻结只发生在 SkillPool(镜像 ToolPool)。
//
// 装载模型：
// - builtin + user 与工作区无关，合并为 core；启动时、安装/卸载后由 refreshCore() 重扫；
// - project 技能跟随工作区，在每次 list(workspaceRoot) 时现扫——多工作区 Session 各自看到
//   自己工作区的 project 技能，互不覆盖；"安装/工作区变化影响下一根 Turn"由此天然成立。
import type { SkillStore } from './store.js';
import { scanBuiltinSkills } from './sources/builtin.js';
import { scanProjectSkills } from './sources/project.js';
import type { SkillDescriptor, SkillKey } from './types.js';

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
  /**
   * 当前全量(含禁用项);禁用过滤是 Pool 冻结时的事。
   * 传入 workspaceRoot 时附带该工作区的 project 技能（现扫现算）。
   * 调用会等待进行中的首次 core 装载，避免启动竞态下读到空目录。
   */
  list(workspaceRoot?: string): Promise<readonly SkillDescriptor[]>;
  getByKey(key: SkillKey, workspaceRoot?: string): Promise<SkillDescriptor | undefined>;
}

/**
 * core 刷新流程:builtin 直扫 + user 对账 → 合成 core 全量。
 * 任一来源失败只降级该来源(空数组 + warning),不拖垮整轮刷新。
 */
export function createSkillRegistry(deps: SkillRegistryDeps): SkillRegistry {
  let core: readonly SkillDescriptor[] = [];
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
  }

  async function scanWorkspace(workspaceRoot: string): Promise<readonly SkillDescriptor[]> {
    try {
      return await scanProjectSkills(workspaceRoot);
    } catch {
      return [];
    }
  }

  async function list(workspaceRoot?: string): Promise<readonly SkillDescriptor[]> {
    // 首次装载尚未完成时等待它，而不是把空目录交给调用方；首装失败降级为当前 core。
    if (coreReady) await coreReady.catch(() => undefined);
    const project = workspaceRoot ? await scanWorkspace(workspaceRoot) : [];
    return [...core, ...project];
  }

  return {
    refreshCore(): Promise<void> {
      const run = tail.then(scanCore);
      tail = run.then(() => undefined, () => undefined);
      coreReady ??= run;
      return run;
    },
    list,
    getByKey: async (key: SkillKey, workspaceRoot?: string) =>
      (await list(workspaceRoot)).find((entry) => entry.key === key),
  };
}
