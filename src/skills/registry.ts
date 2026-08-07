// SkillRegistry:活注册表,持有全量技能的当前事实(镜像 ToolRegistry)。
// 不产出中间 snapshot——冻结只发生在 SkillPool(镜像 ToolPool)。
import type { SkillStore } from './store.js';
import { scanBuiltinSkills } from './sources/builtin.js';
import { scanProjectSkills, type ProjectScanOptions } from './sources/project.js';
import type { SkillDescriptor, SkillKey } from './types.js';

export interface SkillRegistryDeps {
  /** user 技能根(<profileDir>/skills)。 */
  readonly userRoot: string;
  /** 内置技能物化目录(<profileDir>/resources/skills)。 */
  readonly builtinRoot: string;
  /** 内置技能随包源目录(发布资源)。 */
  readonly bundledSkillsSource: string;
  readonly store: SkillStore;
  /** project 扫描的 gitignore 判定来源。 */
  readonly projectScan?: ProjectScanOptions;
}

export interface SkillRegistry {
  /** 串行刷新;并发调用自动接在上一棒之后,不交错。 */
  refresh(workspaceRoot?: string): Promise<void>;
  /** 当前全量(含禁用项);禁用过滤是 Pool 冻结时的事。 */
  list(): readonly SkillDescriptor[];
  getByKey(key: SkillKey): SkillDescriptor | undefined;
}

/**
 * 刷新流程:builtin 物化对账 + user 对账 + project 扫描 → 合成全量。
 * 任一来源失败只降级该来源(空数组 + warning),不拖垮整轮刷新。
 */
export function createSkillRegistry(deps: SkillRegistryDeps): SkillRegistry {
  let entries: readonly SkillDescriptor[] = [];
  let tail: Promise<void> = Promise.resolve();

  async function doRefresh(workspaceRoot?: string): Promise<void> {
    const [builtin, user, project] = await Promise.all([
      scanBuiltinSkills({
        bundledSource: deps.bundledSkillsSource,
        materializedRoot: deps.builtinRoot,
      }).catch(() => [] as SkillDescriptor[]),
      deps.store.reconcileUserRoot()
        .then((result) => result.entries)
        .catch(() => [] as SkillDescriptor[]),
      workspaceRoot
        ? scanProjectSkills(workspaceRoot, deps.projectScan ?? {})
            .catch(() => [] as SkillDescriptor[])
        : Promise.resolve([] as SkillDescriptor[]),
    ]);
    entries = [...builtin, ...user, ...project];
  }

  return {
    refresh(workspaceRoot?: string): Promise<void> {
      const run = tail.then(() => doRefresh(workspaceRoot));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    list: () => entries,
    getByKey: (key) => entries.find((entry) => entry.key === key),
  };
}
