// 接收 Rust 的 JSON-RPC 端口接入命令, 并提供前端手动关闭 Narrative 的业务入口.
import { Hono } from 'hono';
import type { NarrativeComposition } from '../../composition/narrative.js';

export function narrativeControlRoute(narrative: Pick<NarrativeComposition, 'attach' | 'shutdown' | 'detach'>) {
  return new Hono()
    .post('/internal/narrative/control', async context => {
      let request: unknown;
      try {
        request = await context.req.json();
      } catch {
        return context.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (!request || typeof request !== 'object') {
        return context.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      }
      const envelope = request as Record<string, unknown>;
      const id = typeof envelope['id'] === 'number' ? envelope['id'] : null;
      if (envelope['jsonrpc'] !== '2.0' || id === null || typeof envelope['method'] !== 'string') {
        return context.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
      }
      if (envelope['method'] === 'narrative.detach') {
        narrative.detach();
        return context.json({ jsonrpc: '2.0', id, result: null });
      }
      if (envelope['method'] !== 'narrative.attach') {
        return context.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
      const params = envelope['params'];
      const port = params && typeof params === 'object' ? (params as Record<string, unknown>)['port'] : undefined;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        return context.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } });
      }
      try {
        await narrative.attach(port);
        return context.json({ jsonrpc: '2.0', id, result: null });
      } catch (error) {
        console.warn('[narrative] attach failed:', error);
        return context.json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
      }
    })
    .post('/api/narrative/shutdown', async context => {
      const accepted = await narrative.shutdown();
      if (!accepted) return context.json({ error: 'narrative_shutdown_unavailable' }, 409);
      return context.json({ status: 'shutting_down' as const });
    });
}
