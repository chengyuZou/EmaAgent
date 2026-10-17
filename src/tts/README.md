# TTS

[中文](README-zh.md)

`@ema-agent/tts` prepares a voice from a reference recording and synthesizes text with that voice. It delivers audio format information, PCM sample chunks, and a completion event through an async iterable.

## Use

Create a voice registrar and a synthesis call for the same connection and model. The application supplies a `TTSVoiceReference` containing the audio path, reference text/language, resource name/version, and cloud registration name.

```ts
import {
  createTTSCall,
  createTTSVoiceRegistrar,
  type TTSVoiceReference,
} from '@ema-agent/tts';

async function synthesize(reference: TTSVoiceReference, text: string) {
  const connection = {
    protocol: 'gpt-sovits-tts',
    baseUrl: 'http://127.0.0.1:9880',
  } as const;
  const register = createTTSVoiceRegistrar(connection, 'local');
  const callTTS = createTTSCall(connection, 'local');
  const voice = await register(reference);

  for await (const event of callTTS({ text, voice })) {
    // Consume format, audio samples, then completion.
    console.log(event.type);
  }
}
```

The example requires a running GPT-SoVITS service that can read the reference path. That service uses its loaded weights; its `/tts` request does not include the model ID. All factories still require a nonblank model ID.

For cloud protocols, registration uploads the reference recording and returns a provider voice ID for the target model. GPT-SoVITS returns the local reference itself. Pass that result as `voice` on each synthesis request, alongside `text`, optional `speed`, and optional `signal`. Text must be nonblank and speed must be positive and finite.

## Protocols

| Protocol | Voice preparation | Synthesis |
| --- | --- | --- |
| `siliconflow-tts` | HTTP upload, reference file limited to 25 MiB | HTTP PCM stream, explicitly requests 24 kHz mono |
| `gpt-sovits-tts` | Local reference | HTTP WAV stream, reads its actual sample rate and channels |
| `dashscope-tts`, CosyVoice models | HTTP registration, reference file limited to 25 MiB | Task WebSocket, explicitly requests 24 kHz mono PCM |
| `dashscope-tts`, Qwen TTS models | HTTP registration, reference file limited to 25 MiB | Realtime WebSocket, explicitly requests 24 kHz mono PCM |

DashScope selects the family when the factory is called: a `cosyvoice` prefix selects CosyVoice; a `qwen` prefix plus `tts` in the model ID selects Qwen TTS. Other model IDs fail with `tts/unsupported_model`. This selects a protocol format, not a guarantee that every model accepts voice cloning or every request parameter. The Qwen path currently sends no speed parameter.

Default addresses are `https://api.siliconflow.cn/v1`, `http://127.0.0.1:9880`, and `https://dashscope.aliyuncs.com`. DashScope also accepts a WebSocket base URL and derives the corresponding HTTP address for registration.

## Audio stream contract

| Event | Meaning |
| --- | --- |
| `audio_started` | The actual sample rate and channel count, delivered once before samples |
| `audio_chunk` | Nonempty signed PCM16LE samples, with no WAV/MP3/AAC container header |
| `done` | Total delivered PCM bytes and milliseconds from request start to first PCM bytes |

PCM is mono or interleaved stereo. A frame contains one 16-bit sample per channel, so it is 2 bytes for mono and 4 bytes for stereo. Each chunk contains complete frames and is at most 8 KiB. A network block ending halfway through a frame is joined with the next block; an incomplete final frame fails.

The public call checks event order, format, nonempty audio, and final byte counts. The sample rate must be an integer from 8,000 through 192,000 Hz. A successful stream ends with exactly one `done`.

GPT-SoVITS WAV parsing supports headers split across network blocks, extended `fmt ` blocks, and skipped metadata blocks including padding. It accepts linear PCM16LE and keeps the declared sample rate/channels. Its streaming `data` length of zero means PCM continues until EOF; a nonzero length limits reading to that data section.

`packPcmWav(chunks, format)` wraps already collected samples in a complete WAV file. The settings-page preview limits collected PCM to 16 MiB before using it. `createPcmWavHeader(format, pcmByteSize)` creates just the header; `null` writes unknown lengths for continuing audio. A caller writing a completed archive updates it with the actual length.

## Reading, cancellation, and failures

HTTP audio is read as the consumer requests chunks. Node streams can still hold their own read buffers. Failure, cancellation, or leaving iteration early closes the input stream. DashScope callbacks feed `SocketEventQueue`; while open, a failure or cancellation drops queued audio and makes the next read fail. Cleanup closes the WebSocket. CosyVoice waits for `task-started` before sending text; Qwen waits for `session.finished`, not just `response.done`, before ending output.

The WebSocket queue has no separate capacity limit. Qwen limits received PCM to 16 MiB per request; this is not a memory limit for the whole speech pipeline.

`TTSError` exposes codes for invalid requests/responses, unsupported models/voices, missing reference files, credentials, network failures, cancellation, provider failures, and resource limits. HTTP status mapping lives in [errors.ts](errors.ts). Calls make one synthesis attempt; callers set timeouts through `signal` and choose any retry policy. Some underlying file/JSON/abort errors can propagate directly, so consumers must also handle ordinary errors.

## Application calls and code entry points

Server [composition/speech.ts](../../apps/server/src/composition/speech.ts) resolves the TTS connection and character reference. [SpeechVoiceCache](../speech/voiceHandleCache.ts) reuses registered cloud voice IDs in the process. [SpeechCoordinator](../speech/speechCoordinator.ts) submits cleaned text sentence by sentence, consumes PCM, and writes the audio archive. [SpeechVoicePreview](../speech/voicePreview.ts) uses the same calls to produce a bounded preview WAV.

Start at [textToSpeech.ts](textToSpeech.ts) for factories and stream validation. [protocols](protocols) contains each supplier's requests, [audio/pcm.ts](audio/pcm.ts) aligns and splits frames, and [audio/wav.ts](audio/wav.ts) reads and writes WAV headers.

```sh
pnpm --filter @ema-agent/tts test
pnpm --filter @ema-agent/speech test
```

TTS tests use local HTTP/WebSocket servers and in-memory audio to check requests, PCM preservation, WAV parsing, and cancellation. They do not verify a live provider's model availability or voice quality.
