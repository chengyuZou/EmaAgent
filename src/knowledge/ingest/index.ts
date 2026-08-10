// 执行单个文档从校验、解析、分块到可选向量写入的完整导入流程。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createEmbeddingSpace, type EmbeddingSpace } from '@ema-agent/embed';
import type { DocumentAsset, DocumentChunk, IngestOptions, IngestResult } from '../types.js';
import type {
  KnowledgeEmbeddingSelection,
  KnowledgeVisionSelection,
} from '../client.js';
import type { KnowledgeStore } from '../store/index.js';
import { EXT_TO_MIME, parseDocument } from '../parse/index.js';
import { buildPreview } from '../preview/index.js';
import { RecursiveChunker } from '../chunking/recursive.js';
import { SemanticChunker } from '../chunking/semantic.js';
import { assignParents, DEFAULT_CHUNK_OPTIONS } from '../chunking/base.js';
import { ImageReader } from '../readers/image.js';
import { validateFile } from './validate.js';
import { planIngest } from './plan.js';
import { KnowledgeEmbeddingSpaceMismatchError } from '../errors.js';

const EMBED_BATCH_SIZE = 32;
const PARENT_MAX_TOKENS = 1024;

export type IngestStage = 'validate' | 'parse' | 'chunk' | 'embed';

interface IngestDeps {
  readonly store: KnowledgeStore;
  readonly embedding?: KnowledgeEmbeddingSelection;
  readonly vision?: KnowledgeVisionSelection;
  readonly onProgress?: (assetId: string, stage: IngestStage, progress: number) => void;
}

export async function ingest(
  filePath: string,
  options: IngestOptions,
  deps: IngestDeps,
): Promise<IngestResult> {
  const assetId = options.assetId ?? randomUUID();
  const existing = deps.store.getAsset(assetId);
  if (existing?.status === 'error') {
    // 整体重试复用已经落盘的原文件，但从数据库重新建立一份完整文档事实。
    deps.store.deleteAsset(assetId);
  } else if (existing) {
    throw new Error(`Knowledge asset already exists: ${assetId}`);
  }

  const bytes = new Uint8Array(await readFile(filePath));
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = options.mimeType ?? EXT_TO_MIME[extension] ?? 'text/plain';

  report(deps, assetId, 'validate', 0);
  const validation = validateFile(bytes, mimeType);
  if (!validation.ok) throw new Error(`Knowledge document validation failed: ${validation.error}`);

  const duplicate = validation.hash
    ? deps.store.findAssetByHash(validation.hash)
    : undefined;
  if (duplicate?.status === 'indexed') {
    return duplicateResult(duplicate, deps.store);
  }

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const asset: DocumentAsset = {
    id: assetId,
    filePath: options.stagedRelativePath ?? filePath,
    fileName,
    mimeType,
    wordCount: 0,
    contentHash: validation.hash,
    status: 'indexing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    useCount: 0,
  };
  deps.store.addAsset(asset);

  try {
    report(deps, assetId, 'parse', 0.2);
    const imageReader = deps.vision
      ? new ImageReader(deps.vision.vision, {
          model: deps.vision.model,
          signal: options.signal,
        })
      : undefined;
    const parsed = await parseDocument(
      { kind: 'bytes', bytes, name: fileName },
      {
        mimeType,
        imageReader: mimeType.startsWith('image/') ? imageReader : undefined,
        pdfOcrReader: mimeType === 'application/pdf' ? imageReader : undefined,
      },
    );

    deps.store.patchAssetMeta(assetId, {
      title: parsed.title,
      wordCount: parsed.wordCount,
      pageCount: parsed.pageCount,
    });

    report(deps, assetId, 'chunk', 0.4);
    const chunkOptions = { ...DEFAULT_CHUNK_OPTIONS, assetId };
    const plan = planIngest(mimeType, deps.embedding !== undefined);
    const rawChunks = plan.useSemanticChunking && deps.embedding
      ? await new SemanticChunker().chunk(parsed.blocks, {
          ...chunkOptions,
          embedding: deps.embedding.embedding,
          model: deps.embedding.model,
          signal: options.signal,
        })
      : await new RecursiveChunker().chunk(parsed.blocks, chunkOptions);
    const chunks = rawChunks.map((chunk) => ({ ...chunk, assetId }));
    assignParents(chunks, PARENT_MAX_TOKENS);
    deps.store.addChunks(chunks);

    if (deps.embedding && chunks.length > 0) {
      report(deps, assetId, 'embed', 0.5);
      const space = await embedChunks(
        chunks,
        deps.embedding,
        options.signal,
        deps.store,
        (progress) => report(deps, assetId, 'embed', 0.5 + progress * 0.45),
      );
      deps.store.setEmbeddingSpace(assetId, space);
    }

    const preview = await buildPreview(parsed.blocks, {
      assetId,
      mimeType,
      bytes,
      pageCount: parsed.pageCount,
    });
    deps.store.addPreview(preview);
    deps.store.updateStatus(assetId, 'indexed');
    const warnings = parsed.failures.map((failure) => failure.error);
    return {
      asset: {
        ...asset,
        title: parsed.title,
        wordCount: parsed.wordCount,
        pageCount: parsed.pageCount,
        status: 'indexed',
        updatedAt: Date.now(),
      },
      chunks: chunks.length,
      preview,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    deps.store.updateStatus(assetId, 'error');
    throw error;
  }
}

async function embedChunks(
  chunks: readonly DocumentChunk[],
  embedding: KnowledgeEmbeddingSelection,
  signal: AbortSignal | undefined,
  store: KnowledgeStore,
  onProgress: (progress: number) => void,
): Promise<EmbeddingSpace> {
  let space: EmbeddingSpace | undefined;
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
    const response = await embedding.embedding.embed({
      model: embedding.model,
      texts: batch.map((chunk) => chunk.text),
      signal,
    });
    const responseSpace = createEmbeddingSpace({
      providerConfigId: embedding.providerConfigId,
      model: embedding.model,
      dim: response.dim,
    });
    if (space && space.id !== responseSpace.id) {
      throw new KnowledgeEmbeddingSpaceMismatchError(space.id, responseSpace.id);
    }
    space = responseSpace;
    for (let index = 0; index < batch.length; index++) {
      store.storeEmbedding(batch[index]!.id, [...response.embeddings[index]!], responseSpace.id);
    }
    onProgress(Math.min(1, (offset + batch.length) / chunks.length));
  }
  if (!space) throw new Error('Embedding provider returned no vector space');
  return space;
}

function report(deps: IngestDeps, assetId: string, stage: IngestStage, progress: number): void {
  deps.onProgress?.(assetId, stage, progress);
}

function duplicateResult(asset: DocumentAsset, store: KnowledgeStore): IngestResult {
  const preview = store.getPreview(asset.id) ?? {
    assetId: asset.id,
    text: '',
    wordCount: asset.wordCount,
    pageCount: asset.pageCount,
  };
  return {
    asset,
    chunks: store.getChunks(asset.id).length,
    preview,
  };
}
