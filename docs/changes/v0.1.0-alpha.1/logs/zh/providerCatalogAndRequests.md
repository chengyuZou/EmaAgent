# Provider 目录, 设置反馈与请求预算

[English](../en/providerCatalogAndRequests.md)

## 状态

2026-10-20 的源码修复和自动化回归通过, 用户已确认 Provider 在软件中的实际流程通过. 合并后的初始化 SQL 和新增 DeepSeek Vision 预置仍待全新启动验收, 统一安装版验收另行进行. 自动化检查使用内存数据库和模拟 HTTP 响应, 不调用付费模型.

## 已确认原因

- 启停模型触发列表重读, loading 把全部卡片卸载. 已保存的失败探活被初始显示成部分验证, 没有展示实际失败.
- 国内 SiliconFlow 和 Moonshot 地址关联了国际站目录. 目录 ID 决定导入的模型 ID 和参数, 国际站目录可能导入国内接口不可用的 ID.
- 创建 Provider 的路由接收了 `modelsDevId`, 但新建保存时遗漏. 创建页面也没有这个字段.
- 默认 Ping 取模型列表第一行, 即使后面存在已启用模型.
- Narrative 把目录中的模型最大输出容量当作本次请求预算. 安装的 Anthropic SDK 在发送 HTTP 前拒绝非流式 128000 Token 请求, 报出需要 streaming 的错误. 不是实际等待十分钟后超时.

历史图片错误不能合并成一个原因. 模型 ID 不存在, 上游 `403 Model disabled`, 思考参数不支持需要分别判断. 后来一次图片请求成功, 不代表此前所有配置都已验证.

## 修改

- Profile 和 Data 分别只保留 `001_initial.sql`, 数据库版本为 1. Profile 直接预置 `siliconflow-cn` 和 `moonshotai-cn`, 显示名为 `SiliconFlow-CN` 和 `Moonshot Kimi-CN`, 目录 ID 与之对应. 移除国内站 ID 的临时迁移及跨数据库迁移参数. 当前 Alpha 基线要求使用全新应用数据, 不迁移此前开发数据库, 不复制旧凭据和会话.
- 已有 DeepSeek Provider 补充 Vision 能力, 目录 ID 为 `deepseek`, 默认 Chat Completions, 可选 Anthropic 兼容地址. Vision 刷新目录时只导入支持图片输入的模型, 不预选模型或绑定.
- LLM/Vision 创建页及高级配置提供可选 models.dev ID. 清空关联不删除已有模型或绑定. 刷新继续使用 models.dev, 不调用供应商 `/models`. 缺失或不存在的目录关联给出可读配置错误. 已导入旧模型不自动删除.
- Ping 优先取第一个启用模型, 全部禁用时取第一行. LLM/Vision 模型池为空时仍保留原来的目录回退. Vision Ping 明确标注为文本连通性检查.
- 模型后台重读保留卡片. 展示保存的失败探活, 并跟随供应商详情更新. 修改凭据或当前连接时, 在同一事务中清除旧探活结果.
- 公共 LLM 请求继续使用 `thinking`. Chat Completions 协议文件的私有函数只对 SiliconFlow 官方地址拆出 `enable_thinking`, 去掉该次请求中的通用 `thinking`, 并仅对文档列出的模型映射强度. 这个 HTTP 字段不进入公共类型, 设置或 SQL. 其他地址保留原有映射. 依据: [SiliconFlow](https://docs.siliconflow.cn/docs/api/chat-completions-post), [DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/).
- Narrative 保持原生非流式完成接口, 固定 `maxOutputTokens: 8192`. 输出达到上限时仍视为路由不完整, 不使用截断的规划.

## 验证与剩余检查

Storage 测试覆盖独立全新初始化, 国内站 ID 与地址, DeepSeek Vision 协议, 外键, 重复初始化和拒绝较新数据库. Provider 测试覆盖目录选择, 图片输入筛选, 创建, 清空, 旧模型保留及探活失效. Server 测试覆盖默认/显式 Ping 选模, 目录刷新及真实 Narrative 到 Anthropic SDK 的请求, 包括 `stream: false`, `max_tokens: 8192` 和用量保存. LLM 与 Vision 测试检查 HTTP 请求体及错误保留. Desktop DOM 测试覆盖卡片保留, 已存失败更新, 创建字段和清空关联.

Storage, Providers, LLM, Vision 包测试通过, 三个定向 Server 测试文件及五项 Provider 组件测试通过. Storage, Providers, LLM, Server 编译及 Desktop 类型检查通过. 单独的 Anthropic 预算诊断测试已删除, 由实际 Narrative 调用链的集成测试覆盖.

重置现有应用数据前应退出 Ema, 保留需要恢复的资料. 全新启动后需重新配置凭据, 模型选择和绑定, 并检查国内站条目与 DeepSeek Vision 预置. 真实模型请求可能产生费用. 原 SiliconFlow Timeout 和所有历史图片配置组合没有在模拟 HTTP 测试中逐一复现, 用户实际流程通过也不代表所有上游配置均有效.
