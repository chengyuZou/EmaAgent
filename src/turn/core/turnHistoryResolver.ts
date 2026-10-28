import type { LLMGenerationSource } from '@ema-agent/llm';
import { isLLMProtocol } from '@ema-agent/providers';
import type { Turn } from '../types.js';
import type { TurnStore } from '../store/turnStore.js';

/**
 * 一次 Turn 或手动压缩共用一个 Map, 按需读取历史 Turn 的模型来源.
 * 只读 loadHistory 实际交付的 Turn, 后续追加消息复用这份查询结果.
 */
export function createTurnHistoryResolver(
  turns: Pick<TurnStore, 'getTurn'>,
) {
  const cache = new Map<string, Turn | undefined>();
  const readTurn = (turnId: string): Turn | undefined => {
    if (!cache.has(turnId)) {
      cache.set(turnId, turns.getTurn(turnId));
    }
    return cache.get(turnId);
  };

  return {
    resolveGenerationSource(turnId: string): LLMGenerationSource | undefined {
      const turn = readTurn(turnId);
      // 没有完整模型身份时不伪造生成来源, 协议代码据此决定能否重放推理块.
      if (!turn?.providerId || !turn.modelId || !turn.protocol || !isLLMProtocol(turn.protocol)) {
        return undefined;
      }
      return {
        providerId: turn.providerId,
        modelId: turn.modelId,
        protocol: turn.protocol,
      };
    },
  };
}
