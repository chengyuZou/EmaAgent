// 验证 System SSE 建连即产生首字节，并能由消费者取消响应体。
import { describe, expect, it } from 'vitest';
import { AppEvents } from '../src/application/appEvents.js';
import { systemEventsRoute } from '../src/routes/system/events.js';

describe('System SSE route', () => {
  it('连接建立后立即发送 heartbeat', async () => {
    const response = await systemEventsRoute(new AppEvents()).request('/events');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toBe(
      'event: heartbeat\ndata: {}\n\n',
    );

    await reader!.cancel();
  });
});
