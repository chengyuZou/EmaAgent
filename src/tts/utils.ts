/** 参考音频扩展名 -> 上传时使用的 MIME 类型 */
export function mimeFromExt(ext: string): string {
  switch (ext) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'ogg':
    case 'opus': return 'audio/ogg';
    case 'm4a':  return 'audio/mp4';
    case 'pcm':  return 'audio/L16';
    case 'aac':  return 'audio/aac';
    default:     return 'audio/mpeg';
  }
}

export async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}
