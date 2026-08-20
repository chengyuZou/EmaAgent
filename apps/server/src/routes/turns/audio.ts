// Turn 合并语音文件的只读流式响应。
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { AudioArchive } from '@ema-agent/speech';
import type { TurnStore } from '@ema-agent/turn';

export interface TurnAudioRouteDeps {
  readonly audioArchive: Pick<AudioArchive, 'findMergedFor'>;
  readonly turns: Pick<TurnStore, 'getTurn'>;
}

export function turnAudioRoute(deps: TurnAudioRouteDeps): Hono {
  const app = new Hono();

  app.get('/:turnId/audio', async context => {
    const turnId = context.req.param('turnId');
    const turn = deps.turns.getTurn(turnId);
    if (!turn) return context.json({ error: 'turn_not_found' }, 404);

    const found = deps.audioArchive.findMergedFor(turn.sessionId, turnId);
    if (!found) return context.json({ error: 'audio_not_found' }, 404);

    const stat = await fs.promises.stat(found.path);
    const stream = fs.createReadStream(found.path);
    return new Response(
      Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      {
        headers: {
          'Content-Type': found.mime,
          'Content-Length': String(stat.size),
          'Cache-Control': 'private, max-age=0',
        },
      },
    );
  });

  return app;
}
