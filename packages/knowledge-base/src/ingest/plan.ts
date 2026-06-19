export type ChunkerKind = 'heading' | 'sentence' | 'semantic' | 'token';

export interface IngestPlan {
  readerKind:  'text' | 'html' | 'docx' | 'pdf' | 'image';
  chunkerKind: ChunkerKind;
  /** Prefer semantic chunking when an embedding provider is available. */
  useSemanticChunking: boolean;
}

export function planIngest(mimeType: string, hasEmbedProvider: boolean): IngestPlan {
  const readerKind  = mimeToReader(mimeType);
  const chunkerKind = pickChunker(mimeType, hasEmbedProvider);
  return { readerKind, chunkerKind, useSemanticChunking: hasEmbedProvider && chunkerKind === 'semantic' };
}

function mimeToReader(mime: string): IngestPlan['readerKind'] {
  if (mime.startsWith('image/'))                  return 'image';
  if (mime === 'text/html')                        return 'html';
  if (mime === 'application/pdf')                  return 'pdf';
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return 'docx';
  return 'text';
}

function pickChunker(mime: string, hasEbd: boolean): ChunkerKind {
  if (mime === 'application/pdf')  return hasEbd ? 'semantic' : 'heading';
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return hasEbd ? 'semantic' : 'heading';
  if (mime === 'text/html')        return hasEbd ? 'semantic' : 'sentence';
  if (mime === 'text/markdown')    return hasEbd ? 'semantic' : 'heading';
  if (mime.startsWith('image/'))   return 'token';
  return hasEbd ? 'semantic' : 'sentence';
}
