// Transcribe API：POST /api/providers/transcribe——STT 语音输入转写。
// multipart 上传（file=音频字节，language 可选）走 requestRaw 逃生口；结果类型从路由契约推导。
import { serverClient, type RpcClient, type RpcJson } from './client.js';

export type TranscribeResult = RpcJson<RpcClient['api']['providers']['transcribe']['$post']>;

export const transcribeApi = {
  /** 音频字节转写为文本分段；STT 未绑定时服务端如实 503。 */
  async transcribe(input: {
    audio: Blob;
    mime: string;
    language?: string;
  }): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('file', new File([input.audio], 'input', { type: input.mime || 'application/octet-stream' }));
    if (input.language) form.append('language', input.language);
    const res = await serverClient.requestRaw('/api/providers/transcribe', {
      method: 'POST',
      body: form,
    });
    return res.json();
  },
};
