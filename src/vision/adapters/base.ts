// 定义 Vision 协议 Adapter 的最小执行边界。
import type {
  VisionExtractionResult,
  VisionParseMode,
  VisionProbeResult,
  VisionRequest,
  VisionTask,
} from '../types.js';

/**
 * router 填好默认值（task、parseMode）后传给 adapter 的标准化调用形状。
 * 扩展 VisionRequest，把 task/parseMode 变成必填。
 */
export interface VisionAdapterCall extends Omit<VisionRequest, 'task' | 'parseMode'> {
  task:      VisionTask;
  parseMode: VisionParseMode;
}

/** 每个 provider adapter 必须满足的契约。 */
export interface VisionAdapter {
  extract(request: VisionAdapterCall): Promise<VisionExtractionResult>;
  /** 可选健康检查--没有时 router 退回通用错误。 */
  probe?(model: string, signal?: AbortSignal): Promise<VisionProbeResult>;
}
