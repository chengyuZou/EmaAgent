// 这里放 TTS 包内多个 adapter 共用的纯工具函数：mime 互转、字节拼接、响应文本容错读取。

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

/**
 * 文件扩展名 -> MIME 类型。取 openai-tts（uploadVoice 用，含 flac/m4a）
 * 和 archive（finalizeTurn 用，含 pcm/aac）的并集。
 */
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

/** 拼接两个 Uint8Array。adapter 把零散音频块累积成 ~8KB 块时用。 */
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
