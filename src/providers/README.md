# Ema Provider

Ema 产品源码中的 Provider 静态目录与能力查询模块。它描述供应商是谁、支持哪些能力、每项能力可用什么协议与模型来源，不保存用户密钥，也不直接发起模型 API 请求。

目录位于根 `src`，因为供应商能力是 Ema 的产品业务；内部包名 `@ema-agent/provider` 仅用于建立稳定的 TypeScript 编译与依赖边界，不表示它是可独立发布的公共库。

```text
ProviderCatalogFacade
  └─ ProviderDefinition
      ├─ connection（共享认证与默认地址）
      ├─ branding.iconId（稳定 UI 身份）
      └─ capabilities
          ├─ llm
          ├─ embed
          ├─ rerank
          ├─ vision
          ├─ tts
          └─ stt
```

用户覆盖的协议、地址和能力开关由 Storage 的 `provider_capability_configs` 保存；各模型包只接收 Core 已解析好的运行时配置。UI 通过 `iconId` 在 `@ema-agent/ui` 的 Provider 图标注册表中解析具体图标。
