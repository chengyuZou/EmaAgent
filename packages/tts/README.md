# @ema-agent/tts

面向 AI 角色应用的句级流式 TTS 管道。解决的核心问题：**LLM 输出是带 Markdown 的乱流，TTS 需要的是干净的完整句子**——这个包在两者之间搭桥。

支持声音克隆（上传参考音频 → 复刻音色）和系统预设音色，适配器统一接口，可按需替换服务商。

---

## 目录

- [设计背景](#设计背景)
- [处理管道](#处理管道)
- [快速开始](#快速开始)
- [适配器](#适配器)
- [声音克隆](#声音克隆)
- [TtsCoordinator（流式场景）](#ttscoordinator流式场景)
- [音频归档](#音频归档)
- [API 参考](#api-参考)
- [性能](#性能)
- [扩展指南](#扩展指南)
- [已知局限](#已知局限)

---

## 设计背景

LLM 流式输出文本时，TTS 面临三个问题：

**问题一：块级结构跨 chunk。** ` ``` ` 开头和 ` ``` ` 结尾可能分散在不同的 delta chunk 里，无状态 regex 无法跨 chunk 匹配代码块。

**问题二：不知道句子在哪里结束。** 必须积累足够多的文本才能切出一个完整的合成单元，同时又不能积累太多（延迟会很高）。

**问题三：行内 Markdown 噪音。** `**粗体**`、`` `代码` ``、`https://...` 这些在文本里无害，但被 TTS 念出来会很奇怪。

本包用两层管道解决这三个问题，各层职责严格分离。

---

## 处理管道

```
LLM delta chunk
      │
      ▼  (上游：@ema-agent/emotion 剥离 ACT 标签)
      │
      ▼
TextFilterStream.feed()        ← 有状态层：块级清洗
      │   代码块 → "(python代码)"，数学块 → "(数学公式)"
      │   普通文本零延迟透传（非行首批量扫描，避免逐字符）
      ▼
SentenceSplitter.feed()        ← 有状态层：句子边界检测
      │   yield 完整句子（中英文混合标点，最短 4 字符）
      ▼
TtsClient.synthesize()
      └─ filterSentenceForTts() ← 无状态层：行内 Markdown 清洗
      │   快速路径：纯文本直接 trim()，跳过所有 regex
      ▼
TTS 适配器
（GPT-SoVITS / 硅基 CosyVoice2 / 阿里 DashScope CosyVoice）
```

**分层原则**：需要跨 chunk 维护状态的逻辑在第一层；能在完整句子上用 regex 解决的在第二层。两层之间没有反向依赖。

---

## 快速开始

### 安装

```bash
pnpm add @ema-agent/tts
```

### 最小示例（直接合成）

```typescript
import { TtsClient } from '@ema-agent/tts';
import type { TtsProviderConfig, TtsVoiceRef } from '@ema-agent/tts';

// 1. 创建客户端
const client = new TtsClient([
  {
    id:       'siliconflow',
    protocol: 'openai-tts',
    apiKey:   process.env.SF_API_KEY!,
    baseUrl:  'https://api.siliconflow.cn/v1',
  },
]);

// 2. 准备声音引用（声音克隆场景需先调用 uploadVoice，见下文）
const voice: TtsVoiceRef = {
  voiceUri: 'speech:ema-ema1:abc123',  // uploadVoice() 返回的 URI
};

// 3. 合成
for await (const event of client.synthesize({
  providerId: 'siliconflow',
  model:      'FunAudioLLM/CosyVoice2-0.5B',
  text:       '你好，我是艾玛。',
  voice,
  turnMode:   'chat',
  format:     'mp3',
})) {
  if (event.type === 'audio_chunk') {
    // event.bytes: Uint8Array，直接写文件或推流
  }
}
```

### 健康检查

```typescript
const result = client.healthCheck();
// { ok: true, providers: [{ providerId: 'siliconflow', protocol: 'openai-tts', ok: true }] }
```

---

## 适配器

| 适配器 | protocol | 服务商示例 | 声音克隆 | 系统音色 |
|---|---|---|---|---|
| `OpenAiTtsAdapter` | `openai-tts` | 硅基流动、OpenAI、任意 OpenAI 兼容端点 | ✅ `uploadVoice()` | ✅ |
| `DashscopeTtsAdapter` | `dashscope-tts` | 阿里云 DashScope（CosyVoice V2/V3） | ✅ `uploadVoice()` | ✅ |
| `GptSoVitsTtsAdapter` | `gpt-sovits-tts` | 本地 GPT-SoVITS 服务 | ✅ refAudioPath 直传 | — |

### 配置示例

**硅基流动（CosyVoice2）**

```typescript
const sfConfig: TtsProviderConfig = {
  id:       'siliconflow',
  protocol: 'openai-tts',
  apiKey:   'sk-...',
  baseUrl:  'https://api.siliconflow.cn/v1',
};
```

**阿里 DashScope（CosyVoice V2）**

```typescript
const dsConfig: TtsProviderConfig = {
  id:       'dashscope',
  protocol: 'dashscope-tts',
  apiKey:   'sk-...',
  baseUrl:  'https://dashscope.aliyuncs.com',
};
```

**本地 GPT-SoVITS**

```typescript
const gsvConfig: TtsProviderConfig = {
  id:       'gpt-sovits',
  protocol: 'gpt-sovits-tts',
  apiKey:   '',           // 本地服务无需鉴权
  baseUrl:  'http://127.0.0.1:9880',
};
```

---

## 声音克隆

声音克隆的流程：上传一段参考音频 → 服务商返回 voice URI → 后续合成请求带上这个 URI。

```typescript
import { DashscopeTtsAdapter } from '@ema-agent/tts';

const adapter = new DashscopeTtsAdapter(dsConfig);

// 上传参考音频，获得 voice URI（每个模型需单独上传）
const voiceUri = await adapter.uploadVoice(
  '/path/to/reference.mp3',  // 参考音频路径
  '参考文本内容',              // 参考文本（提升克隆质量）
  'zh',                      // 语言
  'cosyvoice-v2',            // 目标模型（DashScope 的 voice ID 与模型绑定）
);

// 之后的合成请求使用这个 URI
const voice: TtsVoiceRef = { voiceUri };
```

**URI 缓存**

voice URI 应缓存到本地（避免重复上传）。在 EmaAgent 中，缓存键的设计为 `tts.voiceUri.<cardId>.<providerId>.<model>`——之所以包含 model，是因为 DashScope 的 voice ID 与创建时指定的目标模型绑定，跨模型不可复用。

**GPT-SoVITS 不需要 URI**

本地 GPT-SoVITS 在每次合成时直接传参考音频路径（`refAudioPath`），无需提前上传：

```typescript
const voice: TtsVoiceRef = {
  refAudioPath: '/path/to/reference.mp3',
  promptText:   '参考文本',
  promptLang:   'zh',
  // voiceUri 留空，GPT-SoVITS 适配器不使用它
};
```

---

## TtsCoordinator（流式场景）

`TtsCoordinator` 是面向 LLM 流式输出场景的高层封装。它订阅 LLM delta hook，内部完成文本过滤 → 分句 → 串行合成的全流程，并将 `tts_chunk` / `tts_sentence_complete` 事件推入外部队列与 LLM 事件合并输出。

```typescript
import { TtsCoordinator, TtsClient } from '@ema-agent/tts';

const coordinator = new TtsCoordinator({
  turnId:     'turn-001',
  sessionId:  'sess-001',
  voice:      { voiceUri: 'speech:ema-ema1:abc123' },
  providerId: 'siliconflow',
  model:      'FunAudioLLM/CosyVoice2-0.5B',
  turnMode:   'chat',
  ttsClient:  client,
  hooks,                    // HookBus 实例
  emit:       (ev) => queue.push(ev),
  format:     'mp3',
});

coordinator.start();       // 开始监听 afterLlmDelta hook

// ... LLM 流式输出期间，coordinator 自动处理 delta

const { audioPath } = await coordinator.finish(); // 等待所有句子合成完成
```

**并发控制**：V1 串行合成（`concurrency = 1`），每句音频完整输出后才开始下一句。这保证了前端收到的 SSE 事件顺序与句子顺序完全一致，不需要客户端缓冲重排。

**错误隔离**：单句合成失败不中断整条链——错误被捕获并作为 `system_warning` 事件推出，下一句照常合成。

---

## 音频归档

`FsAudioArchive` 将每句音频写入磁盘，Turn 结束后自动合并为单文件，供后续按 Turn ID 回放。

```typescript
import { FsAudioArchive } from '@ema-agent/tts';

const archive = new FsAudioArchive('/data/audio');
// 文件布局：
//   /data/audio/segments/<turnId>/0.mp3
//   /data/audio/segments/<turnId>/1.mp3
//   /data/audio/merged/<turnId>.mp3

// 合并逻辑：不依赖 ffmpeg。
// MP3 文件：剥离各段的 ID3v2 头和 ID3v1 尾后直接拼接帧数据（兼容标准播放器）。
// 其他格式：取第一段作为降级输出。

const mergedPath = await archive.finalizeTurn('turn-001', 'mp3');

// 查询某 Turn 的合并文件（用于 HTTP 回放路由）
const result = archive.findMergedFor('turn-001');
// { path: '/data/audio/merged/turn-001.mp3', mime: 'audio/mpeg' }
```

---

## API 参考

### `TtsClient`

主 Façade，负责路由到对应适配器。

```typescript
class TtsClient {
  constructor(configs: TtsProviderConfig[], adapterOverrides?: ReadonlyMap<string, TtsAdapter>)

  // 热重载（配置变更时调用，不重启服务）
  reload(configs: TtsProviderConfig[]): void
  upsertConfig(config: TtsProviderConfig): void
  removeConfig(providerId: string): void

  // 合成单句（调用方负责：分句、声音解析、voiceUri 已填充）
  synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent>

  // 获取适配器实例（用于 uploadVoice 等扩展操作）
  getAdapter(providerId: string): TtsAdapter | undefined

  // 健康检查（仅验证配置注册，不发起 API 调用）
  healthCheck(): TtsHealthResult
}
```

### `TtsRequest`

```typescript
interface TtsRequest {
  providerId:   string;
  model:        string;
  text:         string;
  voice:        TtsVoiceRef;
  turnMode?:    'chat' | 'narrative' | 'agent';  // 影响行内代码的过滤策略
  format?:      'mp3' | 'pcm' | 'wav' | 'opus';
  sampleRate?:  number;
  speed?:       number;
  abortSignal?: AbortSignal;
}
```

### `TtsStreamEvent`

```typescript
type TtsStreamEvent =
  | { type: 'audio_chunk';  bytes: Uint8Array }
  | { type: 'done';         totalBytes: number; firstByteMs: number }
  | { type: 'error';        code: string; message: string }
```

### `TtsVoiceRef`

```typescript
interface TtsVoiceRef {
  voiceUri?:     string;  // 云端声音 URI（硅基 / DashScope）
  refAudioPath?: string;  // 本地参考音频路径（GPT-SoVITS）
  promptText?:   string;  // 参考文本
  promptLang?:   string;  // 参考语言（'zh' / 'en' 等）
}
```

### `TtsAdapter`（扩展接口）

```typescript
interface TtsAdapter {
  readonly protocol: TtsProtocol;
  stream(req: TtsRequest): AsyncIterable<TtsStreamEvent>;
  uploadVoice?(
    refAudioPath: string,
    promptText:   string,
    promptLang:   string,
    model:        string,
  ): Promise<string>;
}
```

### `filterSentenceForTts`（底层工具函数）

```typescript
function filterSentenceForTts(text: string, opts: { turnMode?: TtsTurnMode }): string
```

对完整句子执行行内 Markdown 清洗。快速路径：句子不含 Markdown / URL / 路径特征字符时直接 `trim()` 返回，跳过所有 regex（纯中文对话 100% 命中）。

`turnMode === 'agent'` 时行内代码被删除；`chat` / `narrative` 模式保留代码文本。

---

## 性能

测试环境：Node.js 20，Intel Core i7-12700H，Windows 11

| 场景 | 结果 |
|---|---|
| `filterSentenceForTts` 纯中文（快速路径） | ~31 μs / 句 |
| `filterSentenceForTts` 密集 Markdown | ~892 μs / 句 |
| `TextFilterStream` 纯文本吞吐 | ~898 MB/s |
| `TextFilterStream` 流式小 chunk（16 字节） | ~404 MB/s |
| `SentenceSplitter` 分句吞吐 | ~86 MB/s |
| 端到端管道（过滤 + 分句） | ~23.2 MB/s |

**关键优化**

1. **批量扫描**：`TextFilterStream` 在 `normal` 状态非行首时用 `indexOf('\n')` 一次定位换行符，整行 `slice` 拼接，跳过逐字符 `step()` 调用。对 20-60 字符的典型行，函数调用次数减少约 95%。

2. **快速路径**：`filterSentenceForTts` 入口检测特征字符集 `[<![\]*_\`$#>\\-~|:\\/]`，不命中则直接 `trim()` 返回。纯中文全角标点不触发此检测。

3. **正则合并**：`RE_LINE_PREFIX` 合并了 heading / blockquote / 无序列表 / 有序列表四条规则；`RE_BOLD` 合并了 `**text**` 和 `__text__` 两条规则，用函数 replacer 选捕获组。共减少 5 次 `String.replace()` 调用。

4. **回溯防护**：行内代码正则 `` /(`{1,2})([^`\n]{1,500}?)\1/g ``，内容限 500 字符 + 惰性匹配，防止不成对反引号导致灾难性回溯。

运行完整 benchmark：

```bash
cd packages/tts
npx tsx benchmark.ts
```

---

## 扩展指南

### 新增云端适配器

实现 `TtsAdapter` 接口：

```typescript
import type { TtsAdapter, TtsRequest, TtsStreamEvent, TtsProviderConfig } from '@ema-agent/tts';

export class MyTtsAdapter implements TtsAdapter {
  readonly protocol = 'my-tts' as const;  // 同步到 contracts 的 TtsProtocol 联合类型

  constructor(private readonly config: TtsProviderConfig) {}

  async *stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    // req.text 已经过 filterSentenceForTts 清洗
    // req.voice.voiceUri 由调用方（上层业务）保证已填充
    const response = await fetch(/* ... */);
    for await (const chunk of response.body!) {
      yield { type: 'audio_chunk', bytes: new Uint8Array(chunk) };
    }
    yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
  }

  async uploadVoice(refAudioPath: string, promptText: string, promptLang: string, model: string): Promise<string> {
    // 上传参考音频，返回 voiceUri
  }
}
```

在 `TtsClient.createAdapter()` 里注册新的 `case`，并将 protocol 字面量加入 `contracts` 包的 `TtsProtocol` 联合类型。

### 新增行内过滤规则

在 `src/streaming/text-filter.ts` 顶层添加模块级 regex（避免每次调用重新编译），按正确顺序插入 `filterSentenceForTts` 的 replace 链，并更新 `docs/streaming-pipeline.md` 的处理顺序表。

如果新规则引入了新的特征字符，同步更新快速路径的字符类 `[<![\]*_\`$#>\\-~|:\\/]`。

---

## 已知局限

| 场景 | 表现 | 计划 |
|---|---|---|
| 4 空格缩进代码块 | 无 opener/closer，被当普通文本读出 | V1.5 |
| blockquote 内的代码块 | `> ` 前缀导致行首检测失效 | V1.5 |
| Reference-style 链接 `[text][ref]` | URL 不会被清理 | V1.5 |
| 跨行 `\(` LaTeX | 多行公式泄漏到 TTS | V1.5 |
| 路径语义化 | 路径一律替换为"路径"，不朗读路径内容 | V1.5 |
| MP3 拼接（无 ffmpeg） | 靠 ID3 标签剥离 + 帧拼接，极少数编码器生成的帧边界异常文件可能有杂音 | V1.5 接入 ffmpeg |

---

## License

MIT © EmaAgent Contributors
