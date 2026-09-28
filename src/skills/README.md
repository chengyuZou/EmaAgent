# @ema-agent/skills

Skills 域负责发现 `SKILL.md`, 维护内存注册表, 为根 Turn 冻结 SkillPool, 以及 builtin/user 的索引, 启停与删除和 user 的安装.

`SkillEvent` 只有 `skills_changed`。逐技能启停、删除、重扫与市场安装完成后广播；已打开的设置页和聊天输入技能菜单重新查询目录，事件不携带技能快照。

## 身份

Skill 只有两个跨边界身份字段:

```ts
{
  name: string;
  path: string; // SKILL.md 绝对路径
}
```

`path` 是唯一身份. 不再存在 `SkillKey`, `callName`, path hash 或 `$ARGUMENTS`. 同名 Skill 由不同绝对路径区分.

`SkillDescriptor` 还携带展示和 Prompt 目录实际消费的 `version`, `description`, `whenToUse`, `scope`, `sizeBytes`. Project Skill 额外携带 `projectSourceId`（生态来源级启停）和 `sourceFolderPath`（所属项目源文件夹，供菜单标注出处）。`allowed-tools` 不参与目录投影或权限判断；模型选中技能后由 SkillTool 读取完整 SKILL.md。

## 数据流

```text
builtin/user/project 目录
  -> SkillStore.reconcileBuiltinRoot / SkillStore.reconcileUserRoot / scanProjectSkills
  -> SkillRegistry 按文件夹清单缓存目录
  -> freezeSkillPool
  -> System Prompt 技能目录 + SkillTool
```

- builtin 与 user 在启动,安装,卸载或显式重扫后由 `refreshCore()` 更新.
- project 按源文件夹清单首次扫描并缓存,由 `refreshProjectFolders(folderPaths)` 显式更新.
- `getByPath(path, folderPaths)` 只在 core 和指定文件夹清单中查找，不能读取其他项目的缓存条目.
- 项目源文件夹最多 5 路并发，单文件夹内五个生态根并行发现，文件解析使用 16 路有界并发。每个生态根最多遍历 2,000 个目录，深度最多 6 层.
- Session 有 `projectId` 时扫描项目全部 `folders[]`（空项目不扫描项目 Skill）；否则只扫描其 `cwd`。同一规则用于 Skills 路由、根 Turn 和 `/compact`.
- SkillPool 在 Chat 或 Work 根 Turn 开始时冻结. Turn 中的安装或启停只影响下一根 Turn.

## 持久化

builtin/user 的目录是技能内容事实源. `skills` 按绝对 `SKILL.md path` 保存索引和展示数据, `scope` 区分 builtin/user, `enabled` 保存逐技能开关. project 不进入此表, 仍使用来源级设置.

`SkillStore` 是直接实现业务方法的具体类. 宿主构造 `new SkillStore(profileDb, userRoot, builtinRoot)`, Store 内部构造 Storage 的 `SkillsRepo` 并映射 Row, 不接收独立启停 Repo, 不通过旧工厂转发.

- `reconcileUserRoot()` / `reconcileBuiltinRoot()`: 只对账各自来源, 直接返回 `SkillDescriptor[]`. 重扫更新目录元数据, 不覆盖已有 `enabled` 和 `installed_at`. 损坏目录不展示, 但保留原行和开关; 目录真正消失才删除索引.
- `setEnabled(path, enabled)` / `listDisabledPaths()`: 设置页, 根 Turn 和手动 Compact 使用同一份 `skills.enabled`.
- `finalizeInstall(stagingDir, dirName)`: 校验 staging 中的 SKILL.md, 替换 user 目录后建立索引, 原有启停状态保留.
- `deleteUserSkill(path)` / `deleteBuiltinSkill(path)`: 来源分开, 只删除对应根目录下的直接技能目录与索引. builtin 只删除 profile 的本地副本, 不修改发行包种子; 保留根目录, 普通重启不自动恢复已删技能.
- `sweepOrphanStaging()`: 启动时清理 userRoot 内未完成的安装目录.

HTTP 删除入口为 `DELETE /api/skills/user?skillPath=...` 和 `DELETE /api/skills/builtin?skillPath=...`. 不再提供旧的根路径删除入口, project 无应用删除入口. 逐技能启停仍为 `PUT /api/skills/enabled`.

profile 的 004 迁移保留已有技能数据与开关. user 索引先直接接收旧开关; 尚未索引的路径暂留 `skill_enablement_migration`. 目录对账生成真实索引后, 事务性搬入其开关并移除待搬行, 全部搬完删除迁移表. 缺失或损坏的目录保留待搬记录, 以后修复重扫继续. 正常业务不读取或双写旧开关表.

市场安装先写 userRoot 内 staging 目录,完成后 rename 到目标目录并交给 SkillStore 建索引. 市场来源由 SkillHub 与 ClawHub 的真实 Adapter 各自解析,不使用自定义 `index.json`.

## SkillTool

模型输入固定为:

```ts
{
  name: string;
  path: string;
}
```

Tool 从当前 Turn 的 SkillPool 按 `path` 精确取技能并读取该文件. 返回完整 SKILL.md（含 frontmatter）与资源目录提示. 它不替换 `$ARGUMENTS`,也不按名称猜测技能. 读取互不修改共享状态,允许并发执行.

## Session 引用

用户在输入框选择 Skill 时持久化:

```ts
{
  type: 'skill_reference';
  name: string;
  path: string;
}
```

`name` 用于历史展示,`path` 用于当前 Turn 校验和 Tool 调用. Session 不保存 SKILL.md 正文.
