export type SessionImportErrorCode =
  | 'archive_too_large'
  | 'import_cancelled'
  | 'invalid_zip'
  | 'invalid_format'
  | 'unsupported_version'
  | 'unsafe_archive_path'
  | 'too_many_entries'
  | 'entry_too_large'
  | 'expanded_size_too_large'
  | 'compression_ratio_too_high'
  | 'destination_conflict';

/** 备份业务边界的结构化错误，HTTP/CLI 各自决定如何呈现。 */
export class SessionImportError extends Error {
  constructor(
    readonly code: SessionImportErrorCode,
    message: string,
    readonly status: 400 | 409 | 413 = 400,
  ) {
    super(message);
    this.name = 'SessionImportError';
  }
}
