// 组装 LocalHost 完整对象图，并注册业务 Hook 与跨域事件转发。

import { buildBindings, type AppBindings, type BuildBindingsArgs } from './bindings.js';
import { registerAllHooks }    from './register-hooks.js';
import { registerAllEmitters } from './register-emitters.js';

/**
 * 数据库迁移与关闭由进程入口处理；后台任务通过返回对象中的 BackgroundWork
 * 显式启动，构造对象图本身不再执行中断任务恢复。
 */
export function wire(args: BuildBindingsArgs): AppBindings {
  const bindings = buildBindings(args);
  registerAllHooks(bindings);
  registerAllEmitters(bindings);
  return bindings;
}

// Provider 配置解析仍供 LocalHost 内部装配与定向测试复用。
export type { BuildBindingsArgs } from './bindings.js';
export {
  buildLlmProviderConfig,
  buildEmbedProviderConfig,
  buildRerankProviderConfig,
} from './bindings.js';

export { fetchLlmModels, type FetchedModels } from './providers/llm.js';
export { fetchEmbedModels, type FetchedEmbedModels } from './providers/embed.js';
export {
  resolveNarrativeBridgeUrl,
  configureNarrativeBridge,
} from './narrativeBridge.js';
export { ProviderRuntimeFacade } from './provider-runtime.js';
export type { ProviderRuntimeDependencies } from './provider-runtime.js';
export { registerAllHooks }    from './register-hooks.js';
export { registerAllEmitters } from './register-emitters.js';
