# Settings

[English](README.md)

Settings 读取和保存有类型的应用设置. 业务包声明设置键, 默认值, Zod 校验规则及生效时机. Server 创建 `SettingsStore` 时注册这些定义和有跨字段约束的设置组.

## 定义和使用

```ts
import { z } from 'zod';
import { defineSetting, SettingsStore } from '@ema-agent/settings';
import { SettingsRepo } from '@ema-agent/storage';

const enabledSetting = defineSetting({
  key: 'example.enabled',
  apply: 'nextTurn',
  defaultValue: false,
  schema: z.boolean(),
});
const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite), {
  definitions: [enabledSetting],
});
const enabled = settings.get(enabledSetting);
settings.set(enabledSetting, true);
settings.delete(enabledSetting);
```

SQL 将用户覆盖值保存为 JSON, 定义和默认值留在代码中. `get` 每次读取 Repository 并校验. 缺失或无效时返回默认值的副本; 每个 Store 实例对同一个坏值 key 最多告警一次. 读取不会修复库中的值.

`register` 拒绝重复键. `listDefinitions` 按 key 排序返回已注册定义, `findDefinition` 查不到时返回 undefined. Server 的[设置值 Route](../../apps/server/src/routes/settings/values.ts) 使用这份目录解析提交的设置.

## 保存与通知

`set` 校验一个新值. `setMany` 先校验所有新值, 再由 Repository 在一个事务中保存. 修改的定义包含 `group` 时, Store 将本次新值与组内其他字段的当前有效值或默认值组合, 检查整组约束. 组未注册或组合无效都拒绝写入.

`delete` 删除用户覆盖值, 后续读取使用默认值. 该操作不检查设置组约束.

顺序为校验, 数据库保存, 同步通知监听器. 写库失败不通知. 监听器抛错会向上传递, 但不会撤销已保存的设置. `subscribe` 返回取消订阅函数.

进程内的 `SettingsChangedEvent` 包含修改的 key 和当前 Store 实例自己的通知序号. Server 消费方按 key 处理即时变更. 跨窗口的 `settings_changed` 只通知 Desktop 重新查询, 不携带值或序号.

`apply` 声明业务消费方应在什么时候读取新值: 立即, 下次操作, 下个 Turn 或重启后. Store 不调度这些读取, 实际时机由消费包实现.

## 代码与验证

[types.ts](types.ts) 定义设置与组的契约, [settingsStore.ts](settingsStore.ts) 处理校验和通知, [Storage](../storage/repos/profile/settings.ts) 实现 SQL 读写. [Server 装配](../../apps/server/src/composition/settings.ts) 注册实际业务定义. Desktop 参数组件提供标题, 控件及单位转换.

运行 `pnpm --filter @ema-agent/settings test`. 测试覆盖默认值回退, 值校验, 先保存后通知, 组约束和定义注册.
