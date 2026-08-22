export type SessionExportErrorCode =
  | 'session_not_found'
  | 'export_cancelled'
  | 'export_failed';

export class SessionExportError extends Error {
  constructor(
    readonly code: SessionExportErrorCode,
    message: string,
    readonly status: 404 | 499 | 500 = 500,
  ) {
    super(message);
    this.name = 'SessionExportError';
  }
}

export type SessionImportErrorCode =
  | 'import_cancelled'
  | 'invalid_zip'
  | 'invalid_format'
  | 'unsupported_version'
  | 'unsafe_archive_path'
  | 'archive_bomb'
  | 'destination_conflict'
  | 'restore_failed';

export class SessionImportError extends Error {
  constructor(
    readonly code: SessionImportErrorCode,
    message: string,
    readonly status: 400 | 409 | 413 | 499 | 500 = 400,
  ) {
    super(message);
    this.name = 'SessionImportError';
  }
}
