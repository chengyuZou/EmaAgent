import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DocumentAsset, DocumentChunk, IngestOptions, IngestResult } from '../types.js';
import { EXT_TO_MIME, parseDocument }    from '../parse/index.js';
import { buildPreview }                  from '../preview/index.js';
import { validateFile }                  from './validate.js';
import { planIngest }                    from './plan.js';
import { RecursiveChunker }              from '../chunking/recursive.js';
import { SemanticChunker }               from '../chunking/semantic.js';
import { assignParents }                 from '../chunking/base.js';
import { ImageReader }                   from '../readers/image.js';
import type { KnowledgeStore }           from '../store/index.js';
import type { DocumentEventEmitter }     from '../events/emitter.js';
import type { KbVisionAdapter }          from '../adapters/vision.js';
import type { EbdRouter }                from '@ema-agent/ebd-client';

export interface IngestDeps {
  store:         KnowledgeStore;
  events:        DocumentEventEmitter;
  ebdRouter?:    EbdRouter;
  visionAdapter?: KbVisionAdapter;
}

export async function ingest(
  filePath: string,
  opts:     IngestOptions,
  deps:     IngestDeps,
): Promise<IngestResult> {
  const { store, events, ebdRouter, visionAdapter } = deps;
  const assetId = randomUUID();

  // ── 1. Read + validate ────────────────────────────────────────────────────
  const bytes    = new Uint8Array(await readFile(filePath));
  const ext      = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = opts.mimeType ?? EXT_TO_MIME[ext] ?? 'text/plain';

  events.emit({ assetId, kind: 'validate' });
  const validation = validateFile(bytes, mimeType);
  if (!validation.ok) throw new Error(`[kb/ingest] validation failed: ${validation.error}`);

  // ── 2. Deduplication ──────────────────────────────────────────────────────
  // Skip dedup if the previous ingest errored — allow re-ingest.
  const existing = validation.hash ? store.findAssetByHash(validation.hash) : undefined;
  if (existing && existing.status !== 'error') return buildDuplicateResult(existing, store);

  // ── 3. Store asset (indexing) ──────────────────────────────────────────────
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const asset: DocumentAsset = {
    id: assetId,
    filePath, fileName, mimeType,
    title:       undefined,
    wordCount:   0,
    pageCount:   undefined,
    contentHash: validation.hash,
    status:      'indexing',
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    useCount:    0,
    lastActivatedAt: undefined,
  };
  store.addAsset(asset);

  try {
    // ── 4. Parse ─────────────────────────────────────────────────────────────
    events.emit({ assetId, kind: 'parse' });

    // One vision-backed OCR reader, reused for image/* sources AND scanned PDF
    // pages. Same VisionRouter→KbVisionAdapter chain that already powers image OCR.
    const ocrReader = (visionAdapter && opts.visionProviderId && opts.visionModel)
      ? new ImageReader(visionAdapter, { providerId: opts.visionProviderId, model: opts.visionModel })
      : undefined;

    const parsed = await parseDocument(
      { kind: 'bytes', bytes, name: fileName },
      {
        mimeType,
        imageReader:  mimeType.startsWith('image/')  ? ocrReader : undefined,
        pdfOcrReader: mimeType === 'application/pdf' ? ocrReader : undefined,
      },
    );

    // Backfill parse results into the stored asset row
    if (parsed.title || parsed.wordCount || parsed.pageCount) {
      store.patchAssetMeta(assetId, {
        title:     parsed.title,
        wordCount: parsed.wordCount,
        pageCount: parsed.pageCount,
      });
    }

    // ── 5. Chunk ──────────────────────────────────────────────────────────────
    events.emit({ assetId, kind: 'chunk' });
    const plan     = planIngest(mimeType, !!(ebdRouter && opts.ebdProviderId && opts.ebdModel));
    const chunkOpts = { maxTokens: 512, overlap: 64, minTokens: 20, assetId };

    let rawChunks: DocumentChunk[];
    if (plan.useSemanticChunking && ebdRouter && opts.ebdProviderId && opts.ebdModel) {
      rawChunks = await new SemanticChunker().chunk(parsed.blocks, {
        ...chunkOpts,
        ebdRouter,
        providerId: opts.ebdProviderId,
        model:      opts.ebdModel,
        signal:     opts.signal,
      });
    } else {
      rawChunks = await new RecursiveChunker().chunk(parsed.blocks, chunkOpts);
    }

    const chunks = rawChunks.map(c => ({ ...c, assetId }));
    // Parent-child (small-to-big): stamp momId/momText on children so retrieval
    // can return the larger parent window. Single call site for all chunkers.
    assignParents(chunks, chunkOpts.maxTokens * 4);
    store.addChunks(chunks);

    // ── 6. Embed ──────────────────────────────────────────────────────────────
    if (ebdRouter && opts.ebdProviderId && opts.ebdModel && chunks.length > 0) {
      events.emit({ assetId, kind: 'embed', progress: 0 });
      await embedChunks(chunks, ebdRouter, opts, store, assetId, events);
    }

    // ── 7. Preview ────────────────────────────────────────────────────────────
    const preview = await buildPreview(parsed.blocks, {
      assetId, mimeType, bytes, pageCount: parsed.pageCount,
    });
    store.addPreview(preview);

    // ── 8. Mark indexed ───────────────────────────────────────────────────────
    store.updateStatus(assetId, 'indexed');
    events.emit({ assetId, kind: 'complete', progress: 1 });

    const finalAsset: DocumentAsset = {
      ...asset,
      title:     parsed.title,
      wordCount: parsed.wordCount,
      pageCount: parsed.pageCount,
      status:    'indexed',
      updatedAt: Date.now(),
    };
    return { asset: finalAsset, chunks: chunks.length, preview };

  } catch (err) {
    store.updateStatus(assetId, 'error');
    events.emit({ assetId, kind: 'error', error: String(err) });
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function embedChunks(
  chunks:  DocumentChunk[],
  router:  EbdRouter,
  opts:    IngestOptions,
  store:   KnowledgeStore,
  assetId: string,
  events:  DocumentEventEmitter,
): Promise<void> {
  const BATCH = 32;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    try {
      const res = await router.embed({
        providerId: opts.ebdProviderId!,
        model:      opts.ebdModel!,
        texts:      batch.map(c => c.text),
        signal:     opts.signal,
      });
      for (let j = 0; j < batch.length; j++) {
        const vec = res.embeddings[j];
        if (vec?.length) store.storeEmbedding(batch[j]!.id, vec);
      }
    } catch {
      // Partial failure: skip this batch, chunk is still searchable via FTS5
    }
    events.emit({ assetId, kind: 'embed', progress: Math.min((i + BATCH) / chunks.length, 1) });
  }
}

function buildDuplicateResult(existing: DocumentAsset, store: KnowledgeStore): IngestResult {
  const preview = store.getPreview(existing.id);
  return {
    asset:   existing,
    chunks:  store.getChunks(existing.id).length,
    preview: preview ?? {
      assetId:   existing.id,
      text:      '',
      wordCount: existing.wordCount,
      pageCount: existing.pageCount,
    },
  };
}
