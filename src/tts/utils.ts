// 提供多个 TTS 协议实现共用的 MIME、字节拼接和安全响应读取函数。

/** 音频格式（mp3/pcm/wav/opus）-> MIME 类型。openai-tts / dashscope-tts 共用。 */
export function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'opus': return 'audio/opus';
    case 'pcm':  return 'audio/L16';
    default:     return 'application/octet-stream';
  }
}

/** 参考音频扩展名 -> 上传时使用的 MIME 类型。 */
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

/** 拼接两个 Uint8Array，供 HTTP 音频流重新分成约 8 KiB 的块。 */
export function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 读 Response 文本，失败返回空串（避免 .text() 抛错打断错误分类）。 */
export async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}
