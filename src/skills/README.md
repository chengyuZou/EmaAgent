# @ema-agent/skills — Skill 域(技能注册、冻结池、user 持久化、市场站点、安装)

技能的定义、扫描、启用过滤、安装与站点市场的唯一业务所有者。
架构硬规则：deny 三开关、无 snapshot/原语层/journal。

## 稳定公共接口(只允许从这里消费)

```ts
// 类型
SkillKey / SkillScope / SkillDescriptor / SkillInstallProvenance / SkillPool / ParsedSkillMd

// 三个 deny 设置(Settings 注册用)
disabledSkillKeysSetting / disabledProjectSourcesSetting / builtinSkillsEnabledSetting

// 解析
parseSkillMd

// 注册表与冻结池
createSkillRegistry(deps)      // 活注册表:refreshCore 装载 builtin+user(启动/安装/卸载后);
                               // list(workspaceRoot) 现扫 project——多工作区互不覆盖
freezeSkillPool(input)         // 根 Turn 冻结:过滤 deny + 排序 + callName
renderSkillListing(pool)       // Prompt 常驻目录(8KB 单遍截断)

// user 域持久化(目录是事实源,SQL 是索引/溯源)
createSkillStore({ repo, userRoot })
  reconcileUserRoot / finalizeInstall / deleteUserSkill / sweepOrphanStaging

// 市场面(多站点)
SkillSiteStore / parseSiteIndex / siteIdForUrl
fetchSiteIndex / refreshSites            // 304 三态;并发刷新,单站失败不级联
reconcileUpdatesOffline / applySkillUpdates

// 安装管道(按 installKey 串行、跨 key 并行)
downloadBundle / extractBundle / installSkillFromSite
```

## 其他包不得复用/穿透的

- **`paths.ts`、installer 内部、`sources/*` 的内部函数**不是公共件;跨包只准走上面的出口。
- **桌面前端不得 import 本包类型**;技能信息经 server Route 下发。
- 启用状态**不在**本包任何 SQL 行里——SkillsRepo/SkillSitesRepo 都不提供 enabled 语义;禁用只经 Settings deny-list,接线方不得给 store 加 setEnabled 一类方法。

## 不变量

- Registry 活、Pool 冻：刷新只更新 Registry;安装/禁用/工作区变化只影响下一根 Turn。
- 目录是事实源：SQL 丢失可由 reconcile 重建;站点溯源(site_id/sha256/version)在对账中保留。
- 写盘只两条路：reconcile 对账与 finalizeInstall 的同卷 rename;staging 必须在 userRoot 内。
- 路径防线(paths.ts + extract.ts)是安全地板;内置技能目录(<profileDir>/resources/skills)由宿主在启动时铺好,本包只读直扫,不物化、不感知打包。

## 失败语义

- 单个技能目录损坏 → 对账跳过并记 reason,不拖垮整轮;
- builtin 源缺失/扫描失败 → warning 降级为空内置集,不阻塞启动;
- 站点拉取失败 → fetch_status='failed' + 旧缓存保留;索引解析失败 = index:null。

## 接线契约(归接线批,本包不接线)

- turnExecution：每根 Turn `freezeSkillPool(registry.list(), settings...)` 的结果塞进 `ToolUseContext.skillPool`;子 Agent 不注入(Skill 工具天然不可见)。
- server:skills 路由组(sites CRUD / install / check-updates / 技能管理)调本包出口,不复制字段。
