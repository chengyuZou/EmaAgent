/**
 * Live integration test — @ema-agent/stt × DashScope
 *
 * Usage:
 *   cd src/stt
 *   DS_API_KEY=sk-xxx npx tsx test-live.ts
 *
 * 覆盖范围：
 *   1. qwen3-asr-flash  — compatible-mode chat/completions，base64 data URI，中文转录
 *   2. openai-stt       — /audio/transcriptions multipart，可选（设 DS_OPENAI_BASE 启用）
 *
 * 测试音频来源：src/tts/test-output/（TTS 合成音频，构成 TTS→STT 闭环测试）
 */

import fs   from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SttRuntime } from '../sttRuntime.js';
import type { SttProviderConfig } from '../types.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DS_KEY       = process.env['DS_API_KEY']      ?? '';
const DS_BASE      = process.env['DS_BASE_URL']      ?? 'https://dashscope.aliyuncs.com';
// Section 2: OpenAI-compatible STT adapter test
//   SF_API_KEY  + SF_BASE  → SiliconFlow  FunAudioLLM/SenseVoiceSmall
//   DS_OPENAI_BASE         → DashScope compatible-mode (if key has quota)
const SF_KEY      = process.env['SF_API_KEY']       ?? '';
const SF_BASE     = process.env['SF_BASE_URL']      ?? 'https://api.siliconflow.cn/v1';
const DS_OPENAI_BASE = process.env['DS_OPENAI_BASE'] ?? '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_OUTPUT = path.resolve(__dirname, '../tts/test-output');

// ── Helpers ───────────────────────────────────────────────────────────────────

function header(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

function pass(label: string, value: string) {
  console.log(`  ✓  ${label}: ${value}`);
}

function skip(label: string, reason: string) {
  console.log(`  ⊘  ${label}: ${reason}`);
}

async function readAudio(filename: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const fullPath = path.join(TTS_OUTPUT, filename);
  const bytes = new Uint8Array(await fs.readFile(fullPath));
  const mime  = 'audio/mpeg';
  console.log(`  ↳ ${filename}  (${bytes.length} bytes)`);
  return { bytes, mime };
}

// ── Section 1a: DashScope native multimodal — qwen-audio-turbo ───────────────
//
// DashScope 原生 multimodal-generation 端点，支持 base64 data URI 音频。
// qwen-audio-turbo 能理解并转录中文语音；content 格式用 {"audio": "data:..."} 键。

async function testQwenAudioNative(b64: string, mime: string) {
  const url = `${DS_BASE.replace(/\/$/, '')}/api/v1/services/aigc/multimodal-generation/generation`;

  const body = {
    model: 'qwen-audio-turbo',
    input: {
      messages: [
        {
          role: 'user',
          content: [
            { audio: `data:${mime};base64,${b64}` },
            { text: '请逐字转录以上音频内容，只输出原文，不要翻译或解释。' },
          ],
        },
      ],
    },
    parameters: {},
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${DS_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);

  const json = JSON.parse(text) as {
    output?:     { choices?: Array<{ message?: { content?: Array<{ text?: string }> } }> };
    request_id?: string;
    usage?:      { input_tokens?: number; output_tokens?: number };
  };

  const content = json.output?.choices?.[0]?.message?.content;
  const transcript = Array.isArray(content)
    ? content.map((c) => c.text ?? '').join('')
    : (content as unknown as string ?? '');
  return { transcript, usage: json.usage };
}

// ── Section 1b: DashScope native ASR — paraformer-v2 (public URL fallback) ───
//
// DashScope ASR 端点仅接受公开 URL，本地文件无法直接用。
// 留作文档参考；实际本地测试用 1a。

async function testParaformerUrl(audioUrl: string) {
  const url = `${DS_BASE.replace(/\/$/, '')}/api/v1/services/audio/asr/transcription`;

  const body = {
    model: 'paraformer-v2',
    input: { file_urls: [audioUrl] },
    parameters: { language_hints: ['zh'] },
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization':       `Bearer ${DS_KEY}`,
      'Content-Type':        'application/json',
      'X-DashScope-Async':   'enable',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as { output?: { task_id?: string }; request_id?: string };
}

// ── Section 2: openai-stt Adapter via SttRuntime ──────────────────────────────
//
// SiliconFlow 支持 FunAudioLLM/SenseVoiceSmall（OpenAI-compatible multipart）。
// 若设了 DS_OPENAI_BASE 则额外测试 DashScope compatible-mode 的同一端点。

async function testOpenAiSttAdapter(
  bytes: Uint8Array,
  mime:  string,
  apiKey: string,
  baseUrl: string,
  model:   string,
  providerId: string,
) {
  const cfg: SttProviderConfig = { id: providerId, protocol: 'openai-stt', apiKey, baseUrl };
  const client = new SttRuntime({ configs: [cfg], usageRecorder: { record: () => undefined } });
  return client.transcribe({ providerId, model, audio: bytes, mime, language: 'zh' });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!DS_KEY) {
    console.error('DS_API_KEY is not set. Export it before running:\n  DS_API_KEY=sk-xxx npx tsx test-live.ts');
    process.exit(1);
  }

  const files = ['dashscope-cosyvoice.mp3', 'siliconflow-cosyvoice2.mp3'];

  // ── 1a. qwen-audio-turbo via DashScope native multimodal endpoint ────────────
  header('1a. qwen-audio-turbo (DashScope native multimodal-generation)');

  for (const filename of files) {
    console.log(`\n  [${filename}]`);
    try {
      const { bytes, mime } = await readAudio(filename);
      const b64 = Buffer.from(bytes).toString('base64');
      const { transcript, usage } = await testQwenAudioNative(b64, mime);
      pass('转录结果', transcript || '(空)');
      if (usage) pass('tokens', `in=${usage.input_tokens}  out=${usage.output_tokens}`);
    } catch (e) {
      console.error(`  ✗  失败: ${(e as Error).message}`);
    }
  }

  // ── 1b. paraformer-v2 (仅文档演示，需公开 URL) ───────────────────────────────
  header('1b. paraformer-v2 (DashScope ASR — 仅公开 URL，本地跳过)');
  skip('跳过', '本地文件需先上传至公开存储（OSS / CDN）才能用此 API');
  console.log('     示例: DS_PUBLIC_URL=https://your-bucket.oss-cn-hangzhou.aliyuncs.com/audio.mp3');

  // ── 2. SttRuntime openai-stt Adapter ─────────────────────────────────────────
  header('2. SttRuntime openai-stt Adapter');

  const adapterCases: Array<{ label: string; apiKey: string; baseUrl: string; model: string; id: string }> = [];

  if (SF_KEY) {
    adapterCases.push({
      label:   'SiliconFlow / FunAudioLLM/SenseVoiceSmall',
      apiKey:  SF_KEY,
      baseUrl: SF_BASE,
      model:   'FunAudioLLM/SenseVoiceSmall',
      id:      'siliconflow',
    });
  }
  if (DS_OPENAI_BASE) {
    adapterCases.push({
      label:   `DashScope compatible-mode / FunAudioLLM/SenseVoiceSmall`,
      apiKey:  DS_KEY,
      baseUrl: DS_OPENAI_BASE,
      model:   'FunAudioLLM/SenseVoiceSmall',
      id:      'dashscope-compat',
    });
  }

  if (adapterCases.length === 0) {
    skip('跳过', '未设置 SF_API_KEY 或 DS_OPENAI_BASE');
  }

  for (const c of adapterCases) {
    console.log(`\n  [${c.label}]`);
    for (const filename of files) {
      console.log(`\n    ${filename}`);
      try {
        const { bytes, mime } = await readAudio(filename);
        const result = await testOpenAiSttAdapter(bytes, mime, c.apiKey, c.baseUrl, c.model, c.id);
        pass('转录结果', result.text || '(空)');
        if (result.segments?.length) {
          console.log(`    ↳ segments: ${result.segments.length} 段`);
          for (const s of result.segments.slice(0, 3)) {
            console.log(`       [${s.startMs}ms–${s.endMs}ms] ${s.text}`);
          }
        }
      } catch (e) {
        console.error(`    ✗  失败: ${(e as Error).message}`);
      }
    }
  }

  // ── 3. Health check ─────────────────────────────────────────────────────────
  header('3. SttRuntime.healthCheck()');

  const cfg: SttProviderConfig = {
    id: 'dashscope', protocol: 'openai-stt', apiKey: DS_KEY, baseUrl: DS_BASE,
  };
  const client = new SttRuntime({ configs: [cfg], usageRecorder: { record: () => undefined } });
  const health = client.healthCheck();
  pass('ok', String(health.ok));
  for (const p of health.providers) {
    pass(`provider[${p.providerId}]`, `protocol=${p.protocol}  ok=${p.ok}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('  完成');
  console.log('─'.repeat(60) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
