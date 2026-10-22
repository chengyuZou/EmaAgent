# Characters

[中文](./README-zh.md)

This package stores character identities, persona text, stage choices, Live2D models, illustrations, and reference audio. `CharacterStore` combines the SQL repositories with files under the character resource directory.

## Use

Create one Store per resource root and pass the open [Storage database](../storage/README.md):

```ts
import { CharacterStore, buildCharacterPrompt } from '@ema-agent/characters';

const characters = new CharacterStore(db, charactersRoot);
const character = characters.current();
const presentation = characters.inspectStagePresentation(character.name);
const sections = buildCharacterPrompt(character, presentation);
```

The constructor clears uncommitted `.staging` files and fills missing Live2D byte counts. Do not construct another Store against the same directory while imports are running.

A character's `name` is immutable. It identifies its SQL rows, resource directory, and Relationship Memory directory. `displayName` is editable and falls back to `name` for display. New characters start inactive with a blank stage. Built-in identities are ordinary editable characters.

The Desktop Host initializes built-in characters only when creating a new Profile. It copies bundled files before Server calls `initializeBuiltinCharacters()`. Subsequent starts do not recreate a character the user deleted.

## Files and imports

```text
characters/
  .staging/<operationId>/
  <characterName>/
    live2d/<modelName>/
    illustration/<fileName>
    voice/<fileName>
    .previews/<modelName>.png
```

Names are normalized to NFC and checked against Windows filename restrictions, including on other platforms. Display-name changes never move files. Mutations for one character run in sequence; mutations for different characters can run concurrently.

| Resource | Import and selection |
| --- | --- |
| Live2D | ZIP or directory. Prepare in staging, validate model references, let Desktop render a PNG preview, then commit. Imports do not become primary automatically. |
| Illustration | Copy the original PNG, JPEG, GIF, or WebP after checking its header. An optional expression name groups up to 10 images. |
| Reference audio | Validate a local regular file, copy it, and store its transcript and language. Limit: 512 MiB and a detected duration of at most 60 seconds. The display name, transcript, and language can be edited after import; the audio file and detected duration stay unchanged. |

Audio validation inspects container headers and selected file ranges, rather than decoding the whole recording. In particular, MP3 duration is an estimate based on the first detected frame's bitrate.

Live2D preparation returns an `importId`; prepared resources are not visible in the resource list. Commit moves the model and preview into place before inserting its SQL row. SQL insertion failure moves them back. Cancel removes the prepared files. These are coordinated file and SQL operations, not a filesystem transaction.

Only one resource of each kind can be primary. Deleting primary reference audio selects the next sample through the Storage transaction. Deleting a primary Live2D model or illustration leaves that selection empty. Model previews stay outside the exported model ZIP.

## Stage and notifications

`inspectStagePresentation()` returns `blank`, `live2d`, `illustration`, or `unavailable`. A missing or invalid selected resource does not silently select a different stage type.

Presentation contains resource names and configuration, not host absolute paths. Server serves authenticated illustration files and Live2D ZIP streams. ZIP generation reads files incrementally.

Live2D semantic names come from `runtime-config.json`:

- `emotionMap` maps an emotion to an Expression name registered in `.model3.json`.
- `motionMap` maps a motion to its registered group and array index.
- Empty mapping entries disable that semantic name. Saving mappings preserves disabled entries.
- Native file references, motions, expressions, and parameter groups remain defined by the model files.

Illustration emotion names come from its expression groups. `buildCharacterPrompt()` uses this same Presentation to advertise available control tags. Persona text cannot contain stage control tags.

After resource writes, `onResourcesChanged()` tells resource consumers to reload. `onPresentationChanged()` is sent when the chosen stage can change. Replacing a preview or importing a non-primary model does not by itself reload the stage.

Server coordinates activation, deletion, and selected resource changes with `SessionRunningRegistry.runWithRegistrationsClosed()`. It checks for active Turn or manual Compact work while new registrations are blocked. When deleting the current character, Server chooses a replacement and passes it to the Store. The SQL transaction rejects deletion of the final character and performs replacement activation with deletion.

## Reading and tests

Start with [store.ts](./store.ts) for import, selection, file rollback, and notifications. Resource parsing lives in [live2d](./live2d/live2dModelResources.ts), [illustration](./illustration/illustrationFiles.ts), and [voice](./voice/voiceSampleValidator.ts). [characterPrompt.ts](./characterPrompt.ts) converts Presentation into prompt sections.

Run `pnpm --filter @ema-agent/characters test` and `pnpm --filter @ema-agent/characters typecheck`. Store tests use temporary directories and a temporary database; they cover identity, deletion, staged imports, mapping validation, previews, competing imports, and startup cleanup. They do not render WebGL or verify every audio container.
