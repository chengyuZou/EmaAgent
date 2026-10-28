# Stage

[中文](README-zh.md)

Stage removes emotion and motion tags from streamed model text and returns matching presentation events. Server supplies the active character's allowed names, then passes each text delta through `StageEngine` before saving or displaying the cleaned text.

## Streaming text

```ts
import { StageEngine } from '@ema-agent/stage';

const stage = new StageEngine({ emotions: ['happy'], motions: ['wave'] });
stage.beginTurn(sessionId);
const first = stage.processChunk('Hello <emot', turnId, sessionId);
const second = stage.processChunk('ion>happy</emotion>there', turnId, sessionId);
const tail = stage.flush(sessionId);
```

The first result contains `Hello `. The second contains `there` and an `emotion_changed` event carrying Session ID, Turn ID and `happy`. The caller publishes returned events and forwards cleaned text. Desktop uses those identities when deciding whether to apply an event to the visible character.

Recognized tags are lowercase `<emotion>name</emotion>` and `<motion>name</motion>`. Names start with an ASCII lowercase letter and continue with lowercase letters, digits or underscores. Whitespace around the name is allowed. A complete tag with an unknown name is removed but emits no event. Repeated known tags each emit an event. Other text and unrelated tags pass through.

## Turn and character changes

`beginTurn` replaces that Session's scanner, so an unfinished tag from a previous Turn cannot affect the next one. Without it, `processChunk` passes text through unchanged. Separate Sessions have separate scanners.

The scanner holds a possible tag suffix between chunks. Its 128-code-unit limit prevents an unclosed tag from holding back all following text. `flush` returns any unfinished suffix as ordinary text and emits no presentation event; it clears the suffix but keeps the scanner.

When the shared character changes, Server calls `reset` and `updateVocabulary` to discard unfinished tags and replace allowed names. Session deletion calls `evictSession`. The consumer decides the current displayed emotion and motion; the engine returns events for each recognized tag.

## Code and checks

[engine.ts](engine.ts) manages Session scanners and checks character names. [parser.ts](parser.ts) recognizes tags split across chunks. [Turn](../turn/core/turnExecutor.ts) forwards cleaned text and events, while [Desktop subscriptions](../../apps/desktop/src/chat/session/sessionSubscriptions.ts) send presentation changes to the active character.

Run `pnpm --filter @ema-agent/stage test`. Tests cover known and unknown names, repeated tags, vocabulary changes, split tags and unrelated model markers.
