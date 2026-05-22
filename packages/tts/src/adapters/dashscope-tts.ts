import type { TtsAdapter, TtsAdapterCall, TtsProviderConfig } from '../types.js';
import type { TtsStreamEvent } from '@ema-agent/contracts';

// ── DashScope (Aliyun百炼) TTS — STUB ────────────────────────────────────────
//
// One adapter, two WS protocols routed by model prefix:
//   - cosyvoice-*  → wss://{host}/api-ws/v1/inference/
//                    {action: 'run-task' → continue-task → finish-task}
//   - qwen*-tts*   → wss://{host}/api-ws/v1/realtime
//                    {type: 'session.update' → input_text_buffer.append → ...}
//
// Voice kinds supported (per capability matrix):
//   - catalog (system voices: longanyang, Cherry, ...)
//   - clone   (CosyVoice 声音复刻 — only models cosyvoice-v3.5-* / cosyvoice-v3-flash)
//
// Implementation deferred to round 6B-2. This stub keeps the build green and
// surfaces a clear error so the service-level failover path still works.

export class DashscopeTtsAdapter implements TtsAdapter {
  readonly protocol = 'dashscope-tts' as const;

  constructor(private readonly config: TtsProviderConfig) {
    // Suppress "unused" until impl lands
    void this.config;
  }

  async *stream(call: TtsAdapterCall): AsyncIterable<TtsStreamEvent> {
    void call;
    yield {
      type:    'error',
      code:    'permanent_unsupported_model',
      message: 'dashscope-tts adapter not yet implemented (round 6B-2)',
    };
  }
}

// Public helper so the service can decide which family a model belongs to
// without reaching into the adapter. Useful for routing UI hints later.
export function dashscopeModelFamily(model: string): 'cosyvoice' | 'qwen-tts' | 'unknown' {
  if (model.startsWith('cosyvoice')) return 'cosyvoice';
  if (model.startsWith('qwen') && model.includes('tts')) return 'qwen-tts';
  return 'unknown';
}
