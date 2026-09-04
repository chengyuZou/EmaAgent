// 执行单个文档从校验、解析、分块到可选向量写入的完整导入流程。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { EmbeddingSpace } from '@ema-agent/embed';
import type { CallVision } from '@ema-agent/vision';
import type { DocumentAsset, DocumentChunk, IngestOptions, IngestResult } from '../types.js';
import type { CallEmbed } from '../types.js';
import type { KnowledgeStore } from '../store/store.js';
import { EXT_TO_MIME, parseDocument } from '../parse/parse.js';
import { buildPreview } from '../preview/buildPreview.js';
import { RecursiveChunker } from '../chunking/recursive.js';
import { SemanticChunker } from '../chunking/semantic.js';
import { assignParents, DEFAULT_CHUNK_OPTIONS } from '../chunking/base.js';
import { ImageReader } from '../readers/image.js';
import { validateFile } from './validate.js';
import {
  KnowledgeDocumentProcessingError,
  KnowledgeEmbeddingSpaceMismatchError,
} from '../errors.js';

const EMBED_BATCH_SIZE = 32;
const PARENT_MAX_TOKENS = 1024;

export type IngestStage = 'validate' | 'parse' | 'chunk' | 'embed';

interface IngestDeps {
  readonly store: KnowledgeStore;
  readonly embed?: CallEmbed;
  readonly vision?: CallVision;
  readonly onProgress?: (assetId: string, stage: IngestStage, progress: number) => void;
}

export async function ingest(
  filePath: string,
  options: IngestOptions,
  deps: IngestDeps,
): Promise<IngestResult> {
  const assetId = options.assetId ?? randomUUID();
  const existing = deps.store.getAsset(assetId);
  if (existing) {
    // 既有资产一律接管重建:failed/崩溃残留是重试, ready 是同路径再导入(更新语义)。
    deps.store.deleteAsset(assetId);
  }

  const bytes = new Uint8Array(await readFile(filePath));
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = options.mimeType ?? EXT_TO_MIME[extension] ?? 'text/plain';

  report(deps, assetId, 'validate', 0);
  options.signal?.throwIfAborted();
  const validation = validateFile(bytes, mimeType);
  if (!validation.ok) {
    throw new KnowledgeDocumentProcessingError(`Knowledge document validation failed: ${validation.error}`);
  }

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const asset: DocumentAsset = {
    id: assetId,
    sourcePath: options.sourcePath,
    filePath: options.stagedRelativePath ?? filePath,
    fileName,
    mimeType,
    wordCount: 0,
    status: 'indexing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  deps.store.addAsset(asset);

  try {
    report(deps, assetId, 'parse', 0.2);
    const imageReader = deps.vision
      ? new ImageReader(deps.vision, {
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

    // 阶段边界统一响应取消：无嵌入的纯文本路径不消费 signal，只能靠这些检查点。
    options.signal?.throwIfAborted();

    report(deps, assetId, 'chunk', 0.4);
    const chunkOptions = { ...DEFAULT_CHUNK_OPTIONS, assetId };
    const semantic = useSemanticChunking(mimeType, deps.embed !== undefined);
    const rawChunks = semantic && deps.embed
      ? await new SemanticChunker().chunk(parsed.blocks, {
          ...chunkOptions,
          embed: deps.embed,
          signal: options.signal,
        })
      : await new RecursiveChunker().chunk(parsed.blocks, chunkOptions);
    const chunks = rawChunks.map((chunk) => ({ ...chunk, assetId }));
    assignParents(chunks, PARENT_MAX_TOKENS);
    deps.store.addChunks(chunks);
    options.signal?.throwIfAborted();

    if (deps.embed && chunks.length > 0) {
      report(deps, assetId, 'embed', 0.5);
      const space = await embedChunks(
        chunks,
        deps.embed,
        options.signal,
        deps.store,
        (progress) => report(deps, assetId, 'embed', 0.5 + progress * 0.45),
      );
      deps.store.setEmbeddingSpace(assetId, space);
    }
    options.signal?.throwIfAborted();

    const preview = await buildPreview(parsed.blocks, {
      assetId,
      mimeType,
      bytes,
      pageCount: parsed.pageCount,
    });
    deps.store.addPreview(preview);
    deps.store.updateStatus(assetId, 'ready');
    const warnings = parsed.failures.map((failure) => failure.error);
    return {
      asset: {
        ...asset,
        title: parsed.title,
        wordCount: parsed.wordCount,
        pageCount: parsed.pageCount,
        status: 'ready',
        updatedAt: Date.now(),
      },
      chunks: chunks.length,
      preview,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    deps.store.updateStatus(assetId, 'failed');
    throw error;
  }
}

async function embedChunks(
  chunks: readonly DocumentChunk[],
  embed: CallEmbed,
  signal: AbortSignal | undefined,
  store: KnowledgeStore,
  onProgress: (progress: number) => void,
): Promise<EmbeddingSpace> {
  let space: EmbeddingSpace | undefined;
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
    const response = await embed({
      texts: batch.map((chunk) => chunk.text),
      signal,
    });
    const responseSpace = response.space;
    if (space && space.id !== responseSpace.id) {
      throw new KnowledgeEmbeddingSpaceMismatchError(space.id, responseSpace.id);
    }
    space = responseSpace;
    store.storeEmbeddings(
      batch.map((chunk, index) => ({ id: chunk.id, vector: [...response.embeddings[index]!] })),
      responseSpace.id,
    );
    onProgress(Math.min(1, (offset + batch.length) / chunks.length));
  }
  if (!space) throw new KnowledgeDocumentProcessingError('Embedding provider returned no vector space');
  return space;
}

// 决定本次摄入使用语义分块还是递归分块：有嵌入模型且非图片时用语义分块。
function useSemanticChunking(mimeType: string, hasEmbedding: boolean): boolean {
  return hasEmbedding && !mimeType.startsWith('image/');
}


function report(deps: IngestDeps, assetId: string, stage: IngestStage, progress: number): void {
  deps.onProgress?.(assetId, stage, progress);
}
