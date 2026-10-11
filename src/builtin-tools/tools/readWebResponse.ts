/** 按实际收到的字节数限制下载, 不依赖可能缺失或不准确的 Content-Length. */
export async function readWebResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancelReading = () => {
    // 取消也要结束正在等待的 read(), 不能等下一块数据到了才检查 signal.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancelReading, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`响应体超过 ${maxBytes} 字节上限`);
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener('abort', cancelReading);
    // 超限或取消时停止下载. 连接自身的取消错误不覆盖原来的失败原因.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
