// 这里统一导出 Skill 的存储、运行、安装、解析和 Marketplace 接口。
export { SkillStore, SkillNotFoundError, SkillReadonlyError } from './store.js';
export { SkillRunner }                   from './runner.js';
export { SkillInstaller }                from './installer.js';
export { parseSkillMd, validateSkillMd } from './parser.js';
export {
  SkillMarketAdapter, SKILL_SEEDS,
  listGithubSource, listJsonIndexSource,
} from './market/index.js';
export type {
  GithubSkillSourceConfig,
  SkillJsonIndexConfig,
} from './market/index.js';
export type {
  SkillManifest,
  ActivatedSkill,
  SkillRecord,
  SkillSummary,
  SkillRoot,
  SkillSource,
  SkillFrontmatter,
  MarketSkillEntry,
  GithubSkillCoords,
}                                        from './types.js';
export { GithubSkillCoordsSchema }       from './types.js';
