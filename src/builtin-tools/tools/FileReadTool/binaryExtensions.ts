import path from 'node:path';

// 图片和 PDF 有专门的读取分支, 不属于这份拒绝名单.
const UNSUPPORTED_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.lib',
  '.a', '.pdb', '.class', '.pyc', '.pyo', '.wasm', '.node',
  '.wav', '.mp3', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.tgz', '.iso',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.bmp', '.ico', '.tiff', '.tif', '.psd', '.blend',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.sqlite3', '.db', '.mdb',
]);

export function isUnsupportedBinaryFile(filePath: string): boolean {
  return UNSUPPORTED_BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
