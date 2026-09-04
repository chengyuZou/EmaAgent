const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const ALLOWED_MIME = new Set([
  'text/plain', 'text/markdown', 'text/html',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);

export interface ValidationResult {
  ok:     boolean;
  error?: string;
}

export function validateFile(bytes: Uint8Array, mimeType: string): ValidationResult {
  if (bytes.length > MAX_FILE_SIZE) {
    return { ok: false, error: `File too large: ${bytes.length} bytes (max ${MAX_FILE_SIZE})` };
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    return { ok: false, error: `Unsupported MIME type: ${mimeType}` };
  }
  return { ok: true };
}
