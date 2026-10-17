# STT

[中文](README-zh.md)

`@ema-agent/stt` uploads a complete audio recording to a speech-to-text API and returns text with optional time segments.

## Use

The caller supplies audio bytes read from a file or recording.

```ts
import { createSTTCall } from '@ema-agent/stt';

const transcribe = createSTTCall({
  protocol: 'openai-stt',
  baseUrl: 'http://127.0.0.1:8080/v1',
}, 'transcription-model');

const result = await transcribe({
  audio: audioBytes,
  mimeType: 'audio/wav',
  language: 'en',
  signal: AbortSignal.timeout(30_000),
});
// result.text and optional result.segments
```

`createSTTCall(connection, modelId)` selects the protocol and model. A call accepts `audio`, `mimeType`, optional `language`, and optional `signal`. Empty audio, a blank MIME type, and a blank model ID are rejected.

## Request and response

`openai-stt` means an OpenAI-compatible `POST /audio/transcriptions` format, not a restriction to one supplier. The default base URL is `https://api.openai.com/v1`.

The request is multipart with `file`, `model`, and a nonblank `language` if supplied. It leaves `response_format` unset and reads the default JSON response. Requiring `verbose_json` would reject compatible models that only accept ordinary JSON responses.

A successful response must contain a string `text`. If `segments` is present, each segment must have text and finite, nonnegative times with end at or after start. The protocol converts seconds to rounded milliseconds, returned as `startMs` and `endMs`. A response without segments stays without segments.

HTTP errors and malformed responses raise `STTError`, which carries a code, optional HTTP status, and optional cause. HTTP error messages include at most 500 characters of the provider's response body. Network and cancellation errors from `fetch` propagate as received. Each call makes one request; cancellation and timeout come from the caller's `signal`.

## Application calls and checks

Server [composition/speech.ts](../../apps/server/src/composition/speech.ts) reads the `stt` binding for voice input, or uses an explicitly chosen provider/model for the settings-page test. It resolves the connection, creates `CallSTT`, and records usage. [routes/providers/capabilities.ts](../../apps/server/src/routes/providers/capabilities.ts) reads uploaded audio or requests a transcription of the current character's reference recording. Upload size limits are applied by the Server before audio reaches this package.

Read [speechToText.ts](speechToText.ts) for input and result checks, and [protocols/openAi.ts](protocols/openAi.ts) for multipart fields and response conversion.

```sh
pnpm --filter @ema-agent/stt test
```

Tests replace `fetch` to inspect multipart fields, optional segments, time conversion, invalid inputs, and single-request failures. They do not send audio to a paid provider.
