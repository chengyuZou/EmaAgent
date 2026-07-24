// validateContext 的通用结果构造辅助，供内置工具投影窄 Context 时使用。
import type { ToolContextValidation } from '@ema-agent/tools';

/** 投影成功，携带收窄后的工具专属 Context。 */
export const contextOk = <T>(context: T): ToolContextValidation<T> =>
  ({ valid: true, context });

/** 投影失败（当前调用环境缺少该工具所需能力），携带给模型的 reason。 */
export const contextFail = <T = never>(reason: string): ToolContextValidation<T> =>
  ({ valid: false, reason });
