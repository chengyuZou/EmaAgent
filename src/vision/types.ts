import type { UsageContext } from '@ema-agent/usage';
import type { VisionProtocol } from '@ema-agent/provider';

/** 传给 LLM 告诉它这次任务目标
 * - auto: 让 LLM 自行判断任务类型
 * - caption: 生成图片描述
 * - ocr: 识别图片中的文字
 * - layout: 识别图片中的布局结构
 * - table: 识别图片中的表格
 */
export type VisionTask =
  | 'auto'
  | 'caption'
  | 'ocr'
  | 'layout'
  | 'table';

export type VisionParseMode = 'strict' | 'best_effort';

/** 谁在调用 vision
 * - turn_attachment: 来自当前对话轮的附件
 * - ema_live_vision: 来自 EMA Live Vision 功能(// TODO 想做成实时读屏幕那种暂时没想好等等后续扩展)
 * - system: 系统调用--如 KB 文档解析时的 OCR(PDF 页面转文字)
 */
export type VisionCaller =
  | 'turn_attachment'
  | 'ema_live_vision'
  | 'system';

export interface VisionInvocationContext {
  caller:     VisionCaller;
  sessionId?: string;
  turnId?:    string;
  traceId?:   string;
}

// ── Provider 运行配置 ─────────────────────────────────────────────────────────

export interface VisionProviderConfig {
  /** `provider_configs.id`，不是静态 Provider Definition ID。 */
  id: string;
  protocol: VisionProtocol;
  apiKey: string;
  baseUrl?: string;
}

export type VisionImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

export interface VisionSourceRef {
  localPath?: string;
  url?:       string;
  label?:     string;
}

export type VisionImageInput =
  | {
      kind: 'bytes';
      bytes: Uint8Array;
      mimeType: VisionImageMime;
      name?: string;
      source?: VisionSourceRef;
    }
  | {
      kind: 'base64';
      data: string;
      mimeType: VisionImageMime;
      name?: string;
      source?: VisionSourceRef;
    }
  | {
      kind: 'url';
      url: string;
      mimeType?: VisionImageMime;
      name?: string;
      source?: VisionSourceRef;
    };

/** LLM 返回的 blocks 数组里每个 block 的 kind 字段，parse.ts 的 BLOCK_KINDS 校验合法性(不合法退回 text)
 * - text: 纯文本块
 * - table: 表格块
 * - image: 图片块
 * - layout: 布局块
 * - formula: 公式块
 * - caption: 图片描述块
 */
export type VisionBlockKind =
  | 'text'
  | 'table'
  | 'image'
  | 'layout'
  | 'formula'
  | 'caption';

export interface VisionBlock {
  id: string;
  kind: VisionBlockKind;
  text: string;
  markdown?: string;
  /**
   * 归一化边界框（阅读坐标系）：[x, y, 宽, 高]。
   * provider 能估布局时取值在 0-1 之间。
   */
  bbox?: [number, number, number, number];
  confidence?: number;
  source?: VisionSourceRef;
}

export interface VisionRequest {
  context?: VisionInvocationContext;
  usageContext?: UsageContext;
  /** 底层模型 provider 的 provider_configs.id。 */
  providerId: string;
  /** 所选 provider 期望的原始模型名。 */
  model: string;
  task?: VisionTask;
  inputs: VisionImageInput[];
  language?: string;
  /**
   * 调用方给的额外任务指令。追加到 system 提取 prompt 后面；
   * 不要放原始用户聊天记录。
   */
  prompt?: string;
  parseMode?: VisionParseMode;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  limits?: Partial<VisionLimits>;
}

export interface VisionLimits {
  maxImages: number;
  maxBytesPerImage: number;
  maxTotalBytes: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerProvider: number;
  /** 等待并发槽位的请求上限，防止调用方突发流量形成无界 Promise 队列。 */
  maxQueuedRequests: number;
  timeoutMs: number;
}

export interface VisionExtractionResult {
  context?: VisionInvocationContext;
  providerId: string;
  model: string;
  task: VisionTask;
  text: string;
  markdown?: string;
  blocks: VisionBlock[];
  sources: VisionSourceRef[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  warnings?: string[];
  rawText?: string;
}

export interface VisionProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}
