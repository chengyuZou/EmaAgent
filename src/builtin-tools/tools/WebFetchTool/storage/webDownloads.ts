import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

let downloadsDir: string | undefined;

/** Set once at Server startup. Both WebFetch and Read use the active data directory. */
export function configureWebDownloads(dataDir: string): void {
  downloadsDir = path.join(dataDir, 'web-fetch');
}

export function getWebDownloadsDir(): string | undefined {
  return downloadsDir;
}

export interface WebDownload {
  readonly filePath: string;
  readonly contentType: string;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export async function saveWebDownload(
  directory: string,
  body: Buffer,
  contentType: string,
  signal: AbortSignal,
): Promise<WebDownload> {
  signal.throwIfAborted();
  let mime = contentType.split(';')[0]!.trim().toLowerCase();
  // PDF download endpoints often use octet-stream. Read dispatches by extension.
  if (mime === 'application/octet-stream' && body.subarray(0, 5).toString('ascii') === '%PDF-') {
    mime = 'application/pdf';
  }
  const filePath = path.join(directory, `${randomUUID()}${EXTENSIONS[mime] ?? '.bin'}`);
  const pendingPath = `${filePath}.pending`;
  await mkdir(directory, { recursive: true });
  const file = await open(pendingPath, 'wx');
  try {
    // Never use a remote filename as a path. Publish only the completely written file.
    await file.writeFile(body, { signal });
    await file.close();
    signal.throwIfAborted();
    await rename(pendingPath, filePath);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(pendingPath).catch(() => undefined);
    throw error;
  }
  return { filePath, contentType: mime };
}

export function webDownloadNotice(download: WebDownload, bytes: number): string {
  const { filePath, contentType } = download;
  const readable = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType);
  const nextStep = readable
    ? `Use Read with file_path=${JSON.stringify(filePath)} to inspect this file.`
    : 'The file was saved without decoding. Read may not support this format; use an appropriate file reader.';
  return `Downloaded ${bytes} bytes (${contentType}) to ${filePath}.\n${nextStep}`;
}
