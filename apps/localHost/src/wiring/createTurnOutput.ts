// 装配根 Turn 的可选语音输出、角色语音解析与最终音频统计投影。

import {
  ensureProviderVoiceHandle,
  TurnSpeechOutput,
} from '@ema-agent/tts';
import type { AppBindings } from './bindings.js';
import { resolveVoice } from './providers/tts.js';

/**
 * 角色卡、模型 binding、路径布局和音频记录是进程装配事实。
 * TTS 只取得解析后的合成参数与窄投影回调，不反向读取这些业务对象。
 */
export function createTurnOutput(bindings: AppBindings): TurnSpeechOutput {
  return new TurnSpeechOutput({
    resolveSynthesis: async ({ signal }) => {
      const binding = bindings.modelBindings.get('tts');
      if (!binding) {
        console.warn('[tts] no audio: no `tts` model binding configured');
        return null;
      }

      const card = bindings.card.current();
      const voice = resolveVoice(card.id, bindings.card);
      if (!voice) {
        console.warn(
          `[tts] no audio: card "${card.id}" has no reference audio registered`,
        );
        return null;
      }

      const adapter = bindings.tts.getAdapter(binding.providerConfigId);
      if (!adapter) {
        console.warn(
          `[tts] no audio: no TTS adapter for provider ${binding.providerConfigId}`,
        );
        return null;
      }

      const resolvedVoice = await ensureProviderVoiceHandle(
        voice,
        adapter,
        binding.model,
        card.id,
        binding.providerConfigId,
        bindings.ttsVoiceHandles,
        signal,
      );

      // 本地 GPT-SoVITS 读取参考音频；云端协议必须先得到 Provider 声音句柄。
      if (!resolvedVoice.providerVoice && adapter.protocol !== 'gpt-sovits-tts') {
        console.warn(
          `[tts] no audio: cloud adapter ${adapter.protocol} requires a provider voice handle`,
        );
        return null;
      }

      return {
        voice: resolvedVoice,
        providerId: binding.providerConfigId,
        model: binding.model,
        ttsClient: bindings.tts,
        archive: bindings.audioArchive,
        format: 'mp3',
      };
    },
    recordFinalizedAudio: ({ turnId, sessionId, audio }) => {
      bindings.sessionStats.recordAudioMerged({
        turnId: turnId as string,
        sessionId: sessionId as string,
        storagePath: audio.path,
        mimeType: audio.mime,
        byteSize: audio.byteSize,
        durationMs: audio.durationMs,
        segmentCount: audio.segmentCount,
        createdAt: Date.now(),
      });
    },
  });
}
