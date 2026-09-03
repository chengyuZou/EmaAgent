# @ema-agent/settings

本包只负责类型化 Setting 的定义, SQLite 读写, 单字段校验, 真实跨字段校验和变更事件. 具体 Setting 由业务包拥有并在 Server Composition 注册.

## 公共入口

```ts
defineSetting({ key, apply, defaultValue, schema })

new SettingsStore(repository, {
  definitions,
  groups,
})

settings.get(definition)
settings.set(definition, value)
settings.setMany(entries)
settings.delete(definition)
settings.findDefinition(key)
settings.listDefinitions()
settings.subscribe(listener)
```

`SettingDefinition` 只有这些字段:

- `key`: SQLite 主键和业务身份.
- `apply`: 消费方何时读取新值.
- `defaultValue`: 未覆盖或持久值损坏时的值.
- `schema`: 单字段输入校验.
- `group`: 仅在多个字段存在真实联合约束时使用.

## 规则

- 后端不保存 label、description、单位、控件类型或其他 UI 元数据.
- Desktop 为每个设置编写明确展示, 单位换算只发生在前端.
- `delete` 删除用户覆盖, 下次 `get` 直接得到默认值.
- `get` 不缓存, 每次读取 SQLite 并通过 schema.
- `set` 与 `setMany` 先校验, 再提交 SQLite, 提交成功后才发布变更事件.
- `apply` 不是调度器. `nextTurn` 等语义由真实消费方在对应时点读取来兑现.
- 输入限制或资源预算若不属于用户可调产品行为, 放在所属包 `limits.ts` 中作为全大写具名常量, 不注册为 Setting.

## 不负责

- Provider、角色卡、模型绑定等关系数据.
- 参数页面目录和通用表单生成.
- 前端标题、说明、单位、选项文案和布局.
