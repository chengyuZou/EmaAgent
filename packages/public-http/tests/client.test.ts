// 这里测试公共 HTTP 客户端会在声明长度, 真实流量和取消边界处停止读取.
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readBoundedResponseBody } from '../src/client.js';

function responseStream(headers: IncomingMessage['headers'] = {}): PassThrough & IncomingMessage {
  const stream = new PassThrough() as PassThrough & IncomingMessage;
  stream.headers = headers;
  return stream;
}

describe('公网响应体边界', () => {
  it('声明长度超过预算时不开始读取正文', async () => {
    const response = responseStream({ 'content-length': '2000' });
    await expect(readBoundedResponseBody(
      response,
      100,
      new AbortController().signal,
    )).rejects.toThrow('超过 100 字节上限');
  });

  it('实际流量超过预算时销毁响应', async () => {
    const response = responseStream();
    const result = readBoundedResponseBody(response, 100, new AbortController().signal);
    response.end(Buffer.alloc(101));
    await expect(result).rejects.toThrow('超过 100 字节上限');
  });

  it('预算内返回完整字节', async () => {
    const response = responseStream();
    const result = readBoundedResponseBody(response, 100, new AbortController().signal);
    response.end('市场索引');
    await expect(result).resolves.toEqual(Buffer.from('市场索引'));
  });
});
