import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { FsAudioArchive } from '@ema-agent/speech';
import type { TurnStore } from '@ema-agent/turn';

export interface AudioRouteDeps {
  readonly audioArchive: Pick<FsAudioArchive, 'openRead'>;
  readonly turns: Pick<TurnStore, 'getTurn'>;
}

export const turnAudioRoute = (deps: AudioRouteDeps) =>
  new Hono()
    .get('/:turnId/audio', async context => {
      const turnId = context.req.param('turnId');
      const turn = deps.turns.getTurn(turnId);
      if (!turn) return context.json({ error: 'turn_not_found' }, 404);

      const audio = await deps.audioArchive.openRead(turn.sessionId, turnId, context.req.raw.signal);
      if (!audio) return context.json({ error: 'audio_not_found' }, 404);

      const headers = new Headers({
        'Content-Type': audio.mimeType,
        // 正在生成的响应不能被复用为完成文件; 后续播放仍使用同一个路由地址.
        'Cache-Control': 'no-store',
      });
      if (audio.byteSize !== null) headers.set('Content-Length', String(audio.byteSize));
      return new Response(
        Readable.toWeb(audio.stream) as ReadableStream<Uint8Array>,
        { headers },
      );
    });
