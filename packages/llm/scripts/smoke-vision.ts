/**
 * Vision smoke test — DeepSeek via openai-compat + anthropic compat
 */
import { LlmRouter } from '../src/router.js';
import type { LlmMessage } from '../src/types.js';

const KEY = 'sk-1d68690a08aa42eeb38ea38d88b1855c';

const router = new LlmRouter([
  {
    id: 'ds-openai', provider: 'openai-compat',
    apiKey: KEY, baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'ds-anthropic', provider: 'anthropic',
    apiKey: KEY, baseUrl: 'https://api.deepseek.com/anthropic',
  },
]);

// ── Fetch image with timeout, fall back to a hardcoded 1×1 red PNG ───────────
async function fetchImageBase64(url: string, timeoutMs = 8000): Promise<{ data: string; mime: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf  = await resp.arrayBuffer();
    const mime = resp.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    clearTimeout(timer);
    console.log(`✅ fetched ${(buf.byteLength / 1024).toFixed(1)} KB  (${mime})`);
    return { data: Buffer.from(buf).toString('base64'), mime };
  } catch {
    clearTimeout(timer);
    console.warn(`⚠️  fetch failed, using hardcoded test image`);
    // Minimal valid 1×1 red PNG (from OpenAI docs examples — known good)
    return {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
      mime: 'image/png',
    };
  }
}

// Try a few URLs accessible from CN; falls back to hardcoded if all timeout
const CANDIDATE_URLS = [
  // CN-accessible CDNs first
  'https://gw.alicdn.com/imgextra/i1/O1CN01WYqFr91f6SqRNy7hX_!!6000000003961-0-tps-300-300.jpg',
  'https://img.zcool.cn/community/01de4c5f8c5df10000012e7ea6cf58.jpg@260w_195h_1c_1e_1o_100sh.jpg',
  'https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/1893f9d6c2b84b8db0c7e93f99a3adc7~tplv-k3u1fbpfcp-zoom-1.image',
  'https://httpbin.org/image/jpeg',
];

let imageB64 = '';
let imageMime = 'image/png';

console.log('⬇  Fetching test image...');
for (const url of CANDIDATE_URLS) {
  const result = await fetchImageBase64(url, 6000).catch(() => null);
  if (result) { imageB64 = result.data; imageMime = result.mime; break; }
}
if (!imageB64) {
  const fallback = await fetchImageBase64('', 0).catch(() => ({
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
    mime: 'image/png',
  }));
  imageB64 = fallback.data; imageMime = fallback.mime;
}

// ── Shared multimodal message ─────────────────────────────────────────────────
const messages: LlmMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'image_data', data: imageB64, mimeType: imageMime },
      { type: 'text', text: '用一句中文描述这张图片里有什么。' },
    ],
  },
];

// ── openai-compat ─────────────────────────────────────────────────────────────
console.log('\n━━━ openai-compat (deepseek-chat) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
try {
  for await (const chunk of router.stream({ model: 'ds-openai/deepseek-vl2', messages, maxTokens: 200 })) {
    if (chunk.type === 'text_delta')  process.stdout.write(chunk.delta);
    if (chunk.type === 'usage')       console.log(`\n📊 in:${chunk.inputTokens} out:${chunk.outputTokens}`);
    if (chunk.type === 'done')        console.log(`🏁 ${chunk.stopReason}`);
  }
} catch (e) { console.error('❌', (e as Error).message); }

// ── anthropic compat ──────────────────────────────────────────────────────────
console.log('\n━━━ anthropic compat (deepseek-v4-pro) ━━━━━━━━━━━━━━━━━━━━━━━━━');
try {
  for await (const chunk of router.stream({ model: 'ds-anthropic/deepseek-v4-pro', messages, maxTokens: 200 })) {
    if (chunk.type === 'text_delta')  process.stdout.write(chunk.delta);
    if (chunk.type === 'usage')       console.log(`\n📊 in:${chunk.inputTokens} out:${chunk.outputTokens}`);
    if (chunk.type === 'done')        console.log(`🏁 ${chunk.stopReason}`);
  }
} catch (e) { console.error('❌', (e as Error).message); }
