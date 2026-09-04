# @ema-agent/skills

Skills 域负责发现 `SKILL.md`,维护内存注册表,为根 Work Turn 冻结 SkillPool,以及安装和删除用户技能.

## 身份

Skill 只有两个跨边界身份字段:

```ts
{
  name: string;
  path: string; // SKILL.md 绝对路径
}
```

`path` 是唯一身份. 不再存在 `SkillKey`, `callName`, path hash 或 `$ARGUMENTS`. 同名 Skill 由不同绝对路径区分.

`SkillDescriptor` 还携带展示和 Prompt 目录实际消费的 `version`, `description`, `whenToUse`, `suggestedTools`, `scope`, `sizeBytes`. Project Skill 额外携带 `projectSourceId`,只供来源级启停使用.

## 数据流

```text
builtin/user/project 目录
  -> scanBuiltinSkills / SkillStore.reconcileUserRoot / scanProjectSkills
  -> SkillRegistry 内存索引(path -> descriptor)
  -> freezeSkillPool
  -> System Prompt 技能目录 + SkillTool
```

- builtin 与 user 在启动,安装,卸载或显式重扫后由 `refreshCore()` 更新.
- project 按工作区首次扫描并缓存,由 `refreshWorkspace(workspaceRoot)` 显式更新.
- `getByPath()` 直接查内存索引;指定工作区且未命中时重扫该工作区一次.
- Project 的五个生态根并行发现,文件解析使用 16 路有界并发.
- SkillPool 在根 Work Turn 开始时冻结. Turn 中的安装或启停只影响下一根 Turn.

## 持久化

用户 Skill 的目录是事实源. `skills` 表只按绝对 `SKILL.md path` 保存索引和展示数据. `skill_enablement` 按同一路径保存 builtin/user 的禁用状态;project 使用来源级设置.

市场安装先写 userRoot 内 staging 目录,完成后 rename 到目标目录并交给 SkillStore 建索引. 市场来源由 SkillHub 与 ClawHub 的真实 Adapter 各自解析,不使用自定义 `index.json`.

## SkillTool

模型输入固定为:

```ts
{
  name: string;
  path: string;
}
```

Tool 从当前 Turn 的 SkillPool 按 `path` 精确取技能并读取该文件. 返回 SKILL.md 正文与资源目录提示. 它不接受参数,不替换 `$ARGUMENTS`,也不按名称猜测技能. 读取互不修改共享状态,允许并发执行.

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
