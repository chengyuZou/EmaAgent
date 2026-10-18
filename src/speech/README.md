# Speech

[中文](./README-zh.md)

Speech turns visible assistant text into ordered TTS requests and one WAV per Turn and speaking character. Automatic generation accepts text deltas; manual generation feeds the completed reply. Audio generation and desktop playback have separate lifetimes.

## Generation

The Server creates `SpeechCoordinator` with fixed Session/Turn IDs, Provider/model, prepared voice, `CallTTS`, `openAudio(format)`, cancellation and synchronous persistence callbacks. Feed text with `acceptTextDelta`, then await `finish`; `cancel` aborts generation and shares the same completion Promise.

`TextFilterStream` preserves code/math fence state across deltas and substitutes short spoken labels. `SentenceSplitter` keeps abbreviations and decimal dots together, avoids very short pieces, and limits each piece to 200 UTF-16 code units without splitting a surrogate pair. `filterSentenceForTTS` then cleans inline Markdown, URLs and paths.

Sentences run sequentially, each with a 120-second timeout and 16 MiB PCM limit. Every actual TTS request gets a new usage ID. Quantity is submitted text length in UTF-16 units; duration measures the request, not playback.

- Automatic generation uses `savePartialAudio: true`: Provider failure in one sentence reports a warning and continues; cancellation keeps completed PCM.
- Manual generation uses `false`: a failed/cancelled sentence discards this attempt and preserves existing audio.
- File-write failure or a PCM format change stops further appends. Automatic mode can still save earlier completed PCM.

## Files, records and readers

`FsAudioArchive` is created with the sessions directory. The caller must serialize writers for each Session/Turn/character.

```text
CallTTS PCM
  -> await AudioWriter.write
  -> <sessionId>/audio/<turnId>/<turnId>-<characterName>.wav.pending
  -> finish WAV header and publish file
  -> synchronous saveRecord
  -> Server emits session_audio_changed, then generation terminal event
```

The file name uses stable Character.name, which may contain hyphens. `finish(saveRecord)` publishes the WAV, then calls the synchronous record callback. A callback failure restores the previous file or removes a first-time publication. `discard` removes only the current pending file. No PCM means no formal file and a null result.

Wait for each `write` before reading the next TTS chunk. Readers have independent offsets and read at most 64 KiB at a time. Initial-generation readers wait at the current file end for more PCM; completion ends the stream. Closing a reader does not cancel generation. While replacing existing audio, readers continue using the old formal file.

`onAudioReady` fires after the first successful PCM write. An in-progress reader has unknown `byteSize`; HTTP must omit Content-Length. Final records include actual bytes and milliseconds. Crash leftovers and recovery are separate from normal finish/discard behavior.

## Voice preparation and preview

`SpeechVoiceCache.prepare` caches Provider voice IDs in the current Node process using character, resource name/version, Provider and model. Local reference voices still go through the registrar and are not cached. Concurrent preparations are not combined.

`SpeechVoicePreview` prepares the current reference voice, collects up to 16 MiB PCM and returns a complete WAV in memory. It does not create Session audio files. `SpeechVoicePreviewTTS` supplies the matched registrar and synthesis call.

## Host integration and checks

[Server speech composition](../../apps/server/src/composition/speech.ts) chooses character/model, persists `speech_outputs`, serializes generation per Turn, and sends `SpeechGenerateEvent`/ `SpeechArchiveEvent`. Events describe generation, not playback completion. The desktop owns its audio element, playback queue and lip sync; stopping playback does not inherently cancel generation.

Start with [speechCoordinator.ts](./speechCoordinator.ts), then [audioArchive.ts](./audioArchive.ts). `tests/audioArchive.test.ts` uses real temporary WAV files and SQLite usage records to check reading, cancellation, replacement and save rollback. The other tests check filtering and voice caching.

```sh
pnpm --filter @ema-agent/speech test
```

Tests do not replace real Provider or WebView audio checks. There is no whole-Turn queued-text limit. The filter is heuristic: for example an unclosed math block currently flushes the code label, and the plain-text fast path retains a numeric list prefix. Long recordings, ordinary WAV size limits, browser buffering and seeking need separate runtime checks.

