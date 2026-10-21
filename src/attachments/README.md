# Attachments

[中文](README-zh.md)

`@ema-agent/attachments` saves image copies and long pasted text, associates them with Turns, and cleans up old unused files. It also caches Vision descriptions for images that a chat model cannot receive directly.

## Save and send

Server constructs `ImageStore` and `PastedTextStore` with their Storage repositories, the active data directory, and an optional event callback. `AttachmentStore` receives those two stores.

| Input | Saved form | On send |
| --- | --- | --- |
| PNG, JPEG, GIF, WebP | `attachments/<sessionId>/images/<uuid>.<ext>` under the active data directory and an image row. | Bind the path to the current Turn. |
| Pasted text with length >=1000 | UTF-8 file under `attachments/<sessionId>/pasted/` and a text row. | Bind the path and keep its saved preview. |
| Ordinary file | Original local path. | Resolve its real path and verify it is a regular file. |

```ts
const saved = await imageStore.saveImage(sessionId, bytes, originalName);
const blocks = await attachments.attach(sessionId, turnId, [
  { type: 'image_reference', path: saved.path },
]);
```

The desktop keeps new images and pasted text in its draft, then uploads them in [submitChatDraft](../../apps/desktop/src/chat/input/submitChatDraft.ts) before sending. The [attachment routes](../../apps/server/src/routes/sessions/attachments.ts) call the stores. `attach` binds existing image/text rows and returns the blocks to save in the message. Missing or cross-Session rows reject the send. Binding may replace an earlier Turn association so a failed input can reuse its uploaded files. The image and text bindings and ordinary-file checks are separate operations, not one rollback transaction.

`file_reference` keeps the original file location. Moving or deleting that file can make it unreadable later. [Context](../context/buildAttachmentMessages.ts) reads image bytes for image-capable models or uses a Vision description, while ordinary files and pasted text become path/preview text for the model to read as needed.

## Images and pasted text

Image bytes are decoded and checked for a supported format. `sharp` loads only when processing an image or thumbnail. Files within 3,932,160 bytes and 8000 pixels per edge keep their original bytes. Larger images are resized, then non-JPEG output may be converted to JPEG at quality 85. This is one conversion pass, not a guaranteed final byte limit. Converted animations use the first frame; unchanged files retain their original bytes. `readThumbnail` returns a JPEG up to 256 pixels by default without modifying the original.

Text thresholds and previews use JavaScript string length, measured in UTF-16 code units. `savePastedText` accepts length >= `PASTE_TEXT_MIN_CHARS` and returns the first `PASTE_TEXT_PREVIEW_CHARS` units, currently 100. It writes the original full text to disk.

## Vision cache and cleanup

`VisionDescriptionCache.get(path)` only reads an existing description. `getOrCreate(path, signal, produce)` checks memory, then SQL, then generates a description. Paths are the cache keys; changing the Vision model does not invalidate an existing description. Memory keeps up to 256 entries by default.

Concurrent generation for the same path shares one Promise and the first caller's signal. Later callers do not get independent cancellation. Cached hits return without running generation cancellation checks. A new generation checks cancellation before and after `produce`, trims the result, and rejects empty text.

`sweepIfIdle` checks the supplied idle predicate and a six-hour minimum interval. It removes SQL descriptions last accessed more than 30 days ago, then removes oldest SQL descriptions until the configured size budget is met. The default budget is 64 MiB, configurable from 4 MiB to 1 GiB. This does not clear memory entries. `clearCache()` clears only memory.

`AttachmentStore.sweep` runs image and text cleanup independently and returns both settled results. Each removes old unbound rows and their files, then old files without rows. The default residue age is 30 days. File-removal errors for recorded files are ignored while their rows are removed, so `deletedFiles` and `freedBytes` describe cleanup accounting, not confirmed disk space recovery.

Successful saves and removal of old unbound rows emit `attachments_changed` for the Session. Server uses this to refresh attachment views. Vision cache maintenance does not emit this event.

## Verify

[attachmentStore.ts](attachmentStore.ts) handles send preparation, [imageStore.ts](imageStore.ts) and [pasteStore.ts](pasteStore.ts) handle saved files, and [visionCache.ts](visionCache.ts) handles description reuse.

```sh
pnpm --filter @ema-agent/attachments test
pnpm --filter @ema-agent/attachments typecheck
```

Tests use temporary directories and SQLite to check files, records, image conversion, binding, cache reuse, and cleanup.
