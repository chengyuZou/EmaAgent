# @ema-agent/settings — 类型化用户设置

用户可调产品参数的统一入口。持久化到 `profile.db` 的 settings 表(SQLite 是唯一事实源),
本包提供定义契约、目录、读写主链与变更事件。**不拥有任何具体设置字段**——
字段由业务包在自己的 `settings.ts` 里声明并注册。

## 稳定公共接口

```ts
defineSetting<T>({ key, kind, apply, defaultValue, decode, encode? }): SettingDefinition<T>
class SettingsStore {
  constructor(repository: SettingsRepository)   // Pick<SettingsRepo,'read'|'set'|'setMany'|'delete'>
  get(definition): T                            // 每次过 decode;坏值回落默认并每键告警一次
  set(definition, value): T                     // decode 校验 → 落库 → 发事件
  setMany(entries): void                        // 同上单批,原子落库
  delete(definition): void
  subscribe(listener): unsubscribe              // SettingsChangedEvent { revision, changedKeys }
}
class SettingsCatalog { register/find/list }    // 重复 key 启动期 fail-fast
```

## 所有权与不变量

- **字段定义归业务包**:key、范围、默认值、decode 由字段拥有方声明;本包不感知任何具体 key。
- **提交顺序不可交换**:校验(decode)→ SQLite 提交 → 发布变更事件。持久化失败时
  订阅者不得看到未生效的值;`InvalidSettingValueError` 在校验失败时抛出,库不动。
- **不持有内存缓存**:每次 get 都经 repo 读 + decode。KV 读是微秒级,
  缓存换不来性能却带来"内存与库不一致"风险(2026-08 删除 Snapshot 缓存半)。
- **`apply` 是文档不是机制**:它告诉消费方何时读新值(nextTurn 的由 Turn 装配时读、
  nextOperation 的由操作时惰性读),由消费方式兑现,无强制执行。
- **`encode` 可选**:缺省恒等;只有值不是 JSON 原生形状(Date、品牌 ID 等)才声明。

## 失败语义

- 持久值损坏/类型不符 → 回落 `defaultValue`,每键 `console.warn` 一次,不阻断启动。
- `set` 落库失败 → 异常上抛,事件不发,调用方读到库里旧值。

## 明确不负责

- 不拥有 Provider 配置、角色卡等关系数据(各有明确数据表);凭据只进系统凭据库。
- 不提供通用设置 UI;设置页是前端手写页,经 server 窄路由读写。
- `frontend.*` 域(主题、事件提示外观)是既有例外:声明托管在 `apps/server/src/settings/`,
  因为它们本质是桌面外观偏好,没有更合适的业务包。新增设置字段不要学这个位置。
