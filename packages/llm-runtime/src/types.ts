/**
 * LLM Runtime 内部共享类型。
 *
 * 这里刻意只放“运行时适配器”需要的通用配置，避免把 provider 配置持久化、
 * secret store、UI 状态提前耦合进 llm-runtime。后续 config-kernel 接入时，
 * 只需要把持久化配置转换成这些轻量对象即可。
 */

/** Node 20+ 已内置 fetch；测试里也可以注入 mock fetch。 */
export type RuntimeFetch = typeof fetch;

/** 原生 Provider 的通用初始化配置。 */
export interface NativeProviderConfig {
  /** API Key 明文只允许运行时注入，不能写进 SQLite。 */
  apiKey?: string;
  /** Provider API 根地址，用于代理、私有网关或企业网关。 */
  baseUrl?: string;
  /** 请求建立连接的超时时间；流式响应建立后不会被这个计时器强行中断。 */
  timeoutMs?: number;
  /** 额外请求头，给企业网关、beta header 或调试场景使用。 */
  defaultHeaders?: Record<string, string>;
  /** 可注入 fetch，便于单元测试和未来 Tauri sidecar 自定义网络层。 */
  fetch?: RuntimeFetch;
}

/** Provider 级别的健康检查结果。 */
export interface ProviderHealthCheckResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

/** 原生 Adapter 的可选能力，不要求所有 provider 立刻实现。 */
export interface ProviderRuntimeIntrospection {
  /** 轻量连接测试，通常调用模型列表或一个低成本 endpoint。 */
  testConnection?(): Promise<ProviderHealthCheckResult>;
  /** 远端列模。V1 可以先用静态 catalog，设置页刷新模型时再调用它。 */
  listRemoteModels?(): Promise<readonly string[]>;
}
