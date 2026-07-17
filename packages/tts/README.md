# @ema-agent/tts

面向 AI 角色应用的句级流式 TTS 管道。解决的核心问题: **LLM 输出是带 Markdown 的乱流,TTS 需要的是干净的完整句子**--这个包在两者之间搭桥。

支持声音克隆(上传参考音频 -> 复刻音色)和系统预设音色,适配器统一接口,可按需替换服务商。

---

## 目录

- [设计背景](#设计背景)
- [处理管道](#处理管道)
- [TextFilterStream 状态机](#textfilterstream-状态机)
- [快速开始](#快速开始)
- [适配器](#适配器)
- [声音克隆](#声音克隆)
- [TtsCoordinator(流式场景)](#ttscoordinator流式场景)
- [音频归档](#音频归档)
- [错误处理](#错误处理)
- [API 参考](#api-参考)
- [性能](#性能)
- [扩展指南](#扩展指南)
- [已知局限](#已知局限)

---

## 设计背景

LLM 流式输出文本时,TTS 面临三个问题:

**问题一: 块级结构跨 chunk。** ` ``` ` 开头和 ` ``` ` 结尾可能分散在不同的 delta chunk 里,无状态 regex 无法跨 chunk 匹配代码块。

**问题二: 不知道句子在哪里结束。** 必须积累足够多的文本才能切出一个完整的合成单元,同时又不能积累太多(延迟会很高)。

**问题三: 行内 Markdown 噪音。** `**粗体**`、`` `代码` ``、`https://...` 这些在文本里无害,但被 TTS 念出来会很奇怪。

本包用三层管道解决这三个问题,各层职责严格分离。

---

## 处理管道

```
output_text_delta
      │
      ▼  (上游: @ema-agent/emotion 剥离 ACT 标签)
      │
      ▼
TextFilterStream.feed()        ← 有状态层: 块级清洗(代码块/数学块)
      │   代码块 -> "(python代码)",数学块 -> "(数学公式)"
      │   普通文本零延迟透传(非行首批量扫描,避免逐字符)
      ▼
SentenceSplitter.feed()        ← 有状态层: 句子边界检测
      │   yield 完整句子(中英文混合标点,最短 4 字符)
      ▼
TtsClient.synthesize()
      └─ filterSentenceForTts() ← 无状态层: 行内 Markdown 清洗
      │   快速路径: 纯文本直接 trim(),跳过所有 regex
      ▼
TTS 适配器(OpenAI 兼容 / GPT-SoVITS / DashScope)
```

**分层原则**: 需要跨 chunk 维护状态的逻辑在第一层(TextFilterStream);能在完整句子上用 regex 解决的在第三层(filterSentenceForTts);中间层(SentenceSplitter)只管切句。三层之间没有反向依赖。

**清洗职责边界**:
- **TextFilterStream**(coordinator 调): 剥块级代码块(``` / ~~~)和数学块($$),跨 chunk 状态机
- **filterSentenceForTts**(service 调): 剥行内 markdown(粗体/斜体/链接/图片/行内代码)、网址、路径,无状态
- **ACT 标签**: 由 `@ema-agent/emotion` 包在 engine 内剥,TTS 不碰

---

## TextFilterStream 状态机

TextFilterStream 是一个 5 状态有限状态机,识别 markdown 的代码块(``` / ~~~)和数学块($$),把里面的内容丢弃,关闭时吐一个替换词(`(python代码)` / `(代码)` / `(数学公式)`),让 TTS 别念代码和公式。

### 状态转移图

```
                 行首 3+ 个 ` 或 ~              遇 \n
    normal ──────────────────────► in_opener ──────────► fenced_code
      ▲                                  │                    │
      │                                  │ $$                 │ 行首 3+ 同类字符
      │              行首 2+ 个 $         │                    ▼
      │  normal ◄─── in_opener ◄──────────┘             in_closer ──遇 \n──► normal
      │                                  │                    ▲
      │                                  │                    │ 行首 2 个 $
      │                                  └─► math_block ───────┘
      │                                                       │
      └─────────── flush() 兜底(未闭合块 emit 替换词)─────────┘
```

### 流式输入的核心约束

文本是分块到达的(LLM 流式输出,一个 delta 可能是 `"今天\n```py"`,下一个是 `"thon\nprint(1)\n```"`)。所以状态机要跨 chunk 保留状态:

- `state`: 当前在哪个状态
- `atLineStart`: 当前字符是不是在行首(fence 只能行首开/关,这个标记跨 chunk 保留,因为一个 \n 可能在 chunk 末尾)
- `lineStartBuf`: 行首已收到的 fence 字符(如收到 2 个 ` ` ,还差 1 个才够 3,缓着等下一个 chunk)。最多缓存 2 个(代码块需 3、数学块需 2,所以 2 就够判数学块,第 3 个到才判代码块)
- `langTag`: opener 行的语言标识(````python` 的 "python",跨 chunk 收集)

### 逐状态说明

**1. `normal`(正常文本)**

绝大多数时间在这。两种子情况:

- **行首**(`atLineStart=true`): 逐字符看是不是 fence 开头。收到 ` ` / `~` / `$` 就存进 `lineStartBuf`,凑够数量(代码 3 / 数学 2)就转 `in_opener`。如果中间来了个不同字符(如 ` ``a ` 的 a),说明不是 fence,把缓存的字符当普通文本吐出。
- **非行首**(`atLineStart=false`): 批量扫描到下一个 \n。因为 fence 只能行首开,行内这一段绝不可能开 fence,可以整段复制不用逐字符 `step()`。这是性能关键(减 95% 调用)。

**2. `in_opener`(已确认 fence 开头,吃 opener 行)**

opener 行是 ` ```python ` 或 ` $$ `。这整个行要丢弃(不念),但**语言标识**(python)要存进 `langTag`,关闭时拼进替换词 `(python代码)`。feed 的快速路径把 opener 行字符往 `langTag` 累加,遇到 \n 就按 `fenceChar` 转 `fenced_code`(` ` 或 `~`)或 `math_block`(`$`)。

**3. `fenced_code`(代码块内容)**

内容全丢,只在行首监控关闭符(3+ 个同类 `fenceChar`)。非行首时整段跳到 \n。行首凑够 3 个同类字符 -> emit 替换词 `(python代码)` 或 `(代码)` -> 转 `in_closer`。

**4. `math_block`(数学块内容)**

和 `fenced_code` 几乎一样,唯一差异: **关闭符是行首 2 个 `$`**(不是 3+)。凑够 2 个 -> emit `(数学公式)` -> 转 `in_closer`。

**5. `in_closer`(关闭符已确认,吃完该行)**

closer 行(` ``` ` 或 ` $$ `)剩余字符也要丢,遇到 \n 回 `normal`。

### flush 兜底

LLM 可能没写关闭符(流断了/输出被截)。flush 时如果还在 `fenced_code` / `math_block` / `in_opener`,按未闭合块处理,emit 替换词(避免代码开头被当普通文本念)。残留的 `lineStartBuf` 当普通文本吐出。

> 注意: flush 对 `math_block` 也走 `codeReplacement()`,所以未闭合的数学块 flush 时吐的是 `(代码)` 而非 `(数学公式)`。只有正常关闭(行首 `$$`)的数学块才吐 `(数学公式)`。

### 替换词

- 代码块: `langTag` 非空 -> `(python代码)`,空 -> `(代码)`
- 数学块(正常关闭): 固定 `(数学公式)`

### 关闭符启发式

- 代码块 closer: 行首 3+ 个与 opener 同类字符即可关闭,不要求数量完全匹配(````` 也能关 ` ``` ` 开的块),不同类字符(` ` 对 `~`)不能关闭对方
- 数学块 closer: 行首 2 个 `$`
- LLM 完全没写关闭符 -> `flush()` 兜底

---

## 快速开始

### 安装

```bash
pnpm add @ema-agent/tts
```

### 最小示例(直接合成)

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

// 2. 准备声音引用(声音克隆场景需先调用 uploadVoice,见下文)
const voice: TtsVoiceRef = {
  refAudioPath: '/abs/path/to/ref.mp3',  // 绝对路径(apps/core 从角色卡解析)
  promptText:   '你好,我是艾玛。',
  promptLang:   'zh',
  voiceUri:     'speech:ema-ema1:abc123',  // uploadVoice() 返回的 URI
};

// 3. 合成
for await (const event of client.synthesize({
  providerId: 'siliconflow',
  model:      'FunAudioLLM/CosyVoice2-0.5B',
  text:       '你好,我是艾玛。',
  voice,
  format:     'mp3',
})) {
  if (event.type === 'audio_chunk') {
    // event.bytes: Uint8Array,event.mime: 'audio/mpeg'
  }
}
```

### 健康检查

```typescript
const result = client.healthCheck();
// { ok: true, providers: [{ providerId: 'siliconflow', protocol: 'openai-tts', ok: true }] }
// V1 只查配置注册,不发实时 API 调用。key 有效性在首次合成时验证。
```

---

## 适配器

| 适配器 | protocol | 服务商示例 | 声音克隆 | 交付方式 |
|---|---|---|---|---|
| `OpenAiTtsAdapter` | `openai-tts` | 硅基流动、OpenAI、任意 OpenAI 兼容端点 | ✅ `uploadVoice()` | http_chunks |
| `GptSoVitsTtsAdapter` | `gpt-sovits-tts` | 本地 GPT-SoVITS 服务 | ✅ refAudioPath 直传 | http_chunks |
| `DashscopeTtsAdapter` | `dashscope-tts` | 阿里云 DashScope | ✅ `uploadVoice()` | 按模型分(CosyVoice 流式 / Qwen-TTS 攒完再发) |

### DashScope 双协议路由

`DashscopeTtsAdapter` 按**模型前缀**走两条 WebSocket 协议(`dashscopeModelFamily` 检测):

- **`cosyvoice-*`** -> `wss://{host}/api-ws/v1/inference/`,流程 `run-task -> continue-task -> finish-task`,音频是**二进制帧流式**(websocket_frames)
- **`qwen*-tts*`** -> `wss://{host}/api-ws/v1/realtime?model=`,流程 `session.update -> input_text_buffer.append/commit -> response.audio.delta -> session.finish`,音频是 **base64 PCM,累积后包 WAV 头一次性 emit**(buffered,16MiB 上限)

V1 不做 WS 连接池(单用户峰值 ~1 QPS,阿里官方推荐连接池是高并发场景)。

### 配置示例

**硅基流动(CosyVoice2)**

```typescript
const sfConfig: TtsProviderConfig = {
  id:       'siliconflow',
  protocol: 'openai-tts',
  apiKey:   'sk-...',
  baseUrl:  'https://api.siliconflow.cn/v1',
};
```

**阿里 DashScope**

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

声音克隆的流程: 上传一段参考音频 -> 服务商返回 voice URI -> 后续合成请求带上这个 URI。

```typescript
import { DashscopeTtsAdapter } from '@ema-agent/tts';

const adapter = new DashscopeTtsAdapter(dsConfig);

// 上传参考音频,获得 voice URI(每个模型需单独上传)
const voiceUri = await adapter.uploadVoice(
  '/path/to/reference.mp3',  // 参考音频路径
  '参考文本内容',              // 参考文本(提升克隆质量)
  'zh',                      // 语言
  'cosyvoice-v2',            // 目标模型(DashScope 的 voice ID 与模型绑定)
);

// 之后的合成请求使用这个 URI
const voice: TtsVoiceRef = {
  refAudioPath: '/path/to/reference.mp3',
  promptText:   '参考文本内容',
  promptLang:   'zh',
  voiceUri,
};
```

**URI 缓存**

voice URI 应缓存到本地(避免重复上传)。在 EmaAgent 中,缓存键的设计为 `tts.voiceUri.<cardId>.<providerId>.<model>`--之所以包含 model,是因为 DashScope 的 voice ID 与创建时指定的目标模型绑定,跨模型不可复用。

**GPT-SoVITS 不需要 URI**

本地 GPT-SoVITS 在每次合成时直接传参考音频路径(`refAudioPath`),无需提前上传:

```typescript
const voice: TtsVoiceRef = {
  refAudioPath: '/path/to/reference.mp3',
  promptText:   '参考文本',
  promptLang:   'zh',
  // voiceUri 留空,GPT-SoVITS 适配器不使用它
};
```

> `refAudioPath` 是**绝对路径**(由 apps/core 的 `resolveCardVoiceRefPath` 从角色卡相对路径解析而来),不是相对路径。

---

## TtsCoordinator(流式场景)

`TtsCoordinator` 是面向 LLM 流式输出场景的高层封装,**per-turn 实例**。它由 apps/core orchestrator 喂入可见的 `output_text_delta`,内部完成文本过滤 -> 分句 -> 串行合成的全流程,并将 `tts_chunk` / `tts_sentence_complete` 事件推入外部队列与 LLM 事件合并输出。

```typescript
import { TtsCoordinator, TtsClient } from '@ema-agent/tts';

const coordinator = new TtsCoordinator({
  turnId:     'turn-001',
  sessionId:  'sess-001',
  voice:      {
    refAudioPath: '/voices/ema.wav',
    promptText:   '你好,我是艾玛。',
    promptLang:   'zh',
    voiceUri:     'speech:ema-ema1:abc123',
  },
  providerId: 'siliconflow',
  model:      'FunAudioLLM/CosyVoice2-0.5B',
  ttsClient:  client,
  emit:       (ev) => queue.push(ev),
  format:     'mp3',
  signal,
});

// ... apps/core 合并 engine stream 时喂入可见文本
coordinator.acceptTextDelta('你好,');
coordinator.acceptTextDelta('今天想聊什么?');

const { audio } = await coordinator.finish();
// audio: FinalizedAudio | null(归档写了合并文件时非 null)
// FinalizedAudio = { path, mime, byteSize, durationMs, segmentCount }
```

**并发控制**: V1 串行合成(`concurrency = 1`),每句音频完整输出后才开始下一句。这保证了前端收到的 SSE 事件顺序与句子顺序完全一致,不需要客户端缓冲重排。

**错误隔离**: 单句合成失败不中断整条链--错误被捕获并作为 `system_warning` 事件推出,下一句照常合成。

**中止**: `abort()` 丢弃一切(turn 完成前中止时用),调 `discardTurn` 清分段 + merged 文件。幂等,可从 finally 调。

**生命周期状态机**: `accepting -> finishing -> completed` / `accepting -> aborting -> aborted` / 任一 -> `failed`。`finish()` 和 `abort()` 都幂等。

---

## 音频归档

`FsAudioArchive` 将每句音频写入磁盘,Turn 结束后按格式合并为单文件,供后续按 Turn ID 回放。

```typescript
import { FsAudioArchive } from '@ema-agent/tts';

const archive = new FsAudioArchive('/data/sessions');
// 文件布局:
//   /data/sessions/<sessionId>/audio/segments/<turnId>/0.mp3
//   /data/sessions/<sessionId>/audio/segments/<turnId>/1.mp3
//   /data/sessions/<sessionId>/audio/merged/<turnId>.mp3

// 合并(三个参数: sessionId, turnId, ext)
const merged = await archive.finalizeTurn('sess-001', 'turn-001', 'mp3');
// merged: { path, mime, byteSize, durationMs, segmentCount } | null

// 查询某 Turn 的合并文件(用于 HTTP 回放路由)
const result = archive.findMergedFor('sess-001', 'turn-001');
// { path: '.../merged/turn-001.mp3', mime: 'audio/mpeg' }
```

**合并逻辑(不依赖 ffmpeg)**:

| 格式 | 合并方式 |
|---|---|
| **mp3** | 剥离各段 ID3v2 头和 ID3v1 尾(TAG)后拼接帧数据 |
| **pcm** | 直接拼接(裸数据无容器头) |
| **wav** | 校验各段格式一致 -> 重写 RIFF 头 + 拼数据(超 4GiB 抛错) |
| **单段** | 直接 copyFile |
| **ogg/opus** | **不拼**(容器不可字节拼接),返回 null,保留分段 |

多段合并采用流式复制(createWriteStream + createReadStream range),内存占用与整个 Turn 的音频体积无关。

`discardTurn(sessionId, turnId)`: 清分段目录 + merged 目录里该 turn 的文件(abort 时调)。

---

## 错误处理

TTS 错误用 `TtsErrorCode` 联合(12 码),分 `permanent_*`(不可重试)/`transient_*`(可重试)/`aborted`/`resource_exhausted`/`invalid_stream`/`unknown`。错误是 `TtsStreamEvent.error` 事件(adapter yield,不抛异常)。

`errors.ts` 集中三个分类函数,供三个 adapter 共用:

```typescript
import { errorEvent, classifyFetchError, classifyHttpStatus, classifyCloseCode } from '@ema-agent/tts';

// 构造 error 事件
errorEvent('permanent_credentials', 'HTTP 401');

// fetch 抛错 -> AbortError=transient_timeout / 其他=transient_network
classifyFetchError(err);

// HTTP 状态归一: 401/403->credentials, 400/422->bad_request, 404->unsupported_model,
//                408/429->timeout, 5xx->server, 其他->unknown
classifyHttpStatus(401);

// WS close code 归一: 1000->unknown, 1006->network, 1008->bad_request,
//                     4001/4003->credentials, 其他->server
classifyCloseCode(1006);
```

`TtsClient.synthesize` 内部还做:
- 超时(默认 120s/句)-> `transient_timeout`
- 单句字节超限(默认 16MiB)-> `resource_exhausted`
- adapter 流结束但没发 done/error -> `invalid_stream`

`bridge.ts` 的 `ttsEventToEma` 把 error 事件转成 `system_warning` SSE,`permanent_*` 映射 error 级,`transient_*` 映射 warn 级。

---

## API 参考

### `TtsClient`

主 Facade,负责路由到对应适配器(哑分发器,不感知角色卡/voice profile/路径/缓存)。

```typescript
class TtsClient {
  constructor(
    configs: TtsProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, TtsAdapter>,
    limits?: Partial<TtsLimits>,
  )

  // 热重载(配置变更时调用,不重启服务)
  reload(configs: TtsProviderConfig[]): void
  upsertConfig(config: TtsProviderConfig): void
  removeConfig(providerId: string): void

  // 合成单句(调用方负责: 分句、声音解析、voiceUri 已填充)
  synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent>

  // 获取适配器实例(用于 uploadVoice 等扩展操作)
  getAdapter(providerId: string): TtsAdapter | undefined

  // 查询适配器真实交付能力(诊断/设置页用)
  capabilitiesFor(providerId: string, model: string): TtsAdapterCapabilities | undefined

  // 健康检查(仅验证配置注册,不发起 API 调用)
  healthCheck(): TtsHealthResult

  // 实时连通性检查(调 adapter.probe)
  probe(providerId: string): Promise<TtsProbeResult>
}
```

`TtsLimits`(默认值): `timeoutMsPerSentence = 120_000`,`maxBytesPerSentence = 16 MiB`。

### `TtsRequest`

```typescript
interface TtsRequest {
  providerId:   string;
  model:        string;
  text:         string;
  voice:        TtsVoiceRef;
  format?:      'mp3' | 'pcm' | 'wav' | 'opus';
  sampleRate?:  number;
  speed?:       number;
  abortSignal?: AbortSignal;
}
```

### `TtsStreamEvent`

```typescript
type TtsStreamEvent =
  | { type: 'audio_chunk';      bytes: Uint8Array; mime: string }
  | { type: 'sentence_started'; index: number; text: string }
  | { type: 'sentence_done';    index: number; durationMs?: number }
  | { type: 'done';             totalBytes: number; firstByteMs: number }
  | { type: 'error';            code: TtsErrorCode; message: string };
```

### `TtsVoiceRef`

```typescript
interface TtsVoiceRef {
  refAudioPath: string;   // 绝对路径(apps/core 从角色卡解析)
  promptText:   string;   // 参考文本
  promptLang:   string;   // 语言('zh' / 'en' 等)
  voiceUri?:    string;   // 云端声音 URI(openai-tts/dashscope-tts 必需,gpt-sovits-tts 忽略)
}
```

### `TtsAdapter`(扩展接口)

```typescript
interface TtsAdapter {
  readonly protocol: TtsProtocol;
  capabilitiesFor(req: Pick<TtsRequest, 'model'>): TtsAdapterCapabilities;
  stream(req: TtsRequest): AsyncIterable<TtsStreamEvent>;
  uploadVoice?(refAudioPath: string, promptText: string, promptLang: string, model: string): Promise<string>;
  probe?(): Promise<TtsProbeResult>;
}

interface TtsAdapterCapabilities {
  audioDelivery: 'buffered' | 'http_chunks' | 'websocket_frames';
  supportsAbort: boolean;
}
```

### `TtsCoordinator`

```typescript
class TtsCoordinator {
  constructor(args: TtsCoordinatorArgs)
  acceptTextDelta(delta: string): void
  finish(): Promise<{ audio: FinalizedAudio | null }>
  abort(): Promise<void>
}
```

### `filterSentenceForTts`(底层工具函数)

```typescript
function filterSentenceForTts(text: string): string
```

对完整句子执行行内 Markdown 清洗(无状态)。快速路径: 句子不含 Markdown / URL / 路径特征字符时直接 `trim()` 返回,跳过所有 regex(纯中文对话 100% 命中)。

> 注意: 快速路径特征字符集是 `[<![\]*_\`$#>\\-~|:\\/]`。不含这些字符的文本(如 `1. 第一项` 有序列表、纯空格)不进 replace 链,前缀/多空格不被处理。这是已知行为。

---

## 性能

历史基准(Node.js 20,Intel Core i9,Windows 11,仅供参考):

| 场景 | 结果 |
|---|---|
| `filterSentenceForTts` 纯中文(快速路径) | ~31 μs / 句 |
| `filterSentenceForTts` 密集 Markdown | ~892 μs / 句 |
| `TextFilterStream` 纯文本吞吐 | ~898 MB/s |
| `TextFilterStream` 流式小 chunk(16 字节) | ~404 MB/s |
| `SentenceSplitter` 分句吞吐 | ~86 MB/s |
| 端到端管道(过滤 + 分句) | ~23.2 MB/s |

**关键优化**

1. **批量扫描**: `TextFilterStream` 在 `normal` 状态非行首时用 `indexOf('\n')` 一次定位换行符,整行 `slice` 拼接,跳过逐字符 `step()` 调用。对 20-60 字符的典型行,函数调用次数减少约 95%。

2. **快速路径**: `filterSentenceForTts` 入口检测特征字符集,不命中则直接 `trim()` 返回。纯中文全角标点不触发此检测。

3. **正则合并**: `RE_LINE_PREFIX` 合并 heading / blockquote / 无序列表 / 有序列表四条规则;`RE_BOLD` 合并 `**text**` 和 `__text__` 两条规则,用函数 replacer 选捕获组。共减少 5 次 `String.replace()` 调用。

4. **回溯防护**: 行内代码正则 `` /(`{1,2})([^`\n]{1,500}?)\1/g ``,内容限 500 字符 + 惰性匹配,防止不成对反引号导致灾难性回溯。

---

## 扩展指南

### 新增云端适配器

实现 `TtsAdapter` 接口:

```typescript
import type { TtsAdapter, TtsRequest, TtsStreamEvent, TtsProviderConfig } from '@ema-agent/tts';
import { errorEvent, classifyFetchError, classifyHttpStatus } from '@ema-agent/tts';

export class MyTtsAdapter implements TtsAdapter {
  readonly protocol = 'my-tts' as const;  // 同步到 contracts 的 TtsProtocol 联合类型

  capabilitiesFor(): { audioDelivery: 'http_chunks'; supportsAbort: true } {
    return { audioDelivery: 'http_chunks', supportsAbort: true };
  }

  constructor(private readonly config: TtsProviderConfig) {}

  async *stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    // req.text 已经过 filterSentenceForTts 清洗
    // req.voice.voiceUri 由调用方(上层业务)保证已填充
    const response = await fetch(/* ... */);
    if (!response.ok) {
      yield errorEvent(classifyHttpStatus(response.status), `HTTP ${response.status}`);
      return;
    }
    for await (const chunk of response.body!) {
      yield { type: 'audio_chunk', bytes: new Uint8Array(chunk), mime: 'audio/mpeg' };
    }
    yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
  }

  async uploadVoice(refAudioPath: string, promptText: string, promptLang: string, model: string): Promise<string> {
    // 上传参考音频,返回 voiceUri
  }
}
```

在 `TtsClient.createAdapter()` 里注册新的 `case`,并将 protocol 字面量加入 `contracts` 包的 `TtsProtocol` 联合类型。错误分类复用 `errors.ts` 的 `classifyFetchError` / `classifyHttpStatus` / `classifyCloseCode`。

### 新增行内过滤规则

在 `src/streaming/text-filter.ts` 顶层添加模块级 regex(避免每次调用重新编译),按正确顺序插入 `filterSentenceForTts` 的 replace 链。

如果新规则引入了新的特征字符,同步更新快速路径的字符类 `[<![\]*_\`$#>\\-~|:\\/]`。

---

## 已知局限

| 场景 | 表现 | 计划 |
|---|---|---|
| 4 空格缩进代码块 | 无 opener/closer,被当普通文本读出 | V1.5 |
| blockquote 内的代码块 | `> ` 前缀导致行首检测失效 | V1.5 |
| Reference-style 链接 `[text][ref]` | URL 不会被清理 | V1.5 |
| 跨行 `\(` LaTeX | 多行公式泄漏到 TTS | V1.5 |
| 路径语义化 | 路径一律替换为"路径",不朗读路径内容 | V1.5 |
| MP3 拼接(无 ffmpeg) | 靠 ID3 标签剥离 + 帧拼接,极少数编码器生成的帧边界异常文件可能有杂音 | V1.5 接入 ffmpeg |
| filterSentenceForTts 快速路径 | 不含特征字符的文本(有序列表 `1.`、纯空格)不进 replace 链,前缀/多空格不处理 | 保持(性能取舍) |
| flush 兜底数学块 | 未闭合数学块 flush 吐 `(代码)` 而非 `(数学公式)` | 可议 |

---

## License

MIT © EmaAgent Contributors
