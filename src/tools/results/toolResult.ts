// 定义工具执行后写入 Message，并在下一次模型调用中重放的唯一结果结构。
import type { ToolResultContentPart } from '@ema-agent/llm';

export interface ToolResult {
  type: 'tool_result';
  toolUseId: string;
  /**
   * 模型可见内容：执行期由 Tool 的 mapResultToModelContent 投影一次并持久化,
   * Session 重放原样回读,不重算。中立形状归 @ema-agent/llm 所有。
   */
  content: string | ToolResultContentPart[];
  /**
   * UI/审计/持久化消费的类型化事实(TOutput 本体);模型不可见。
   * 必须 JSON 可序列化;体积由 Tool 业务上限约束。
   */
  data?: unknown;
  isError?: boolean;
  durationMs?: number;
  errorCode?: string;
}
