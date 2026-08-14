// 提供 Turn 合并语音文件的只读流式响应。

import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { asTurnId } from '@ema-agent/ids';
import type { SessionStore } from '@ema-agent/session';
import type { AudioArchive } from '@ema-agent/tts';

export interface TurnAudioRouteBindings {
  readonly audioArchive: Pick<AudioArchive, 'findMergedFor'>;
  readonly session: Pick<SessionStore, 'getTurn'>;
}

export function registerTurnAudioRoute(
  app: Hono,
  bindings: TurnAudioRouteBindings,
): void {
  app.get('/:turnId/audio', async (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    const turn = bindings.session.getTurn(turnId);
    if (!turn) return context.json({ error: 'turn_not_found' }, 404);

    const found = bindings.audioArchive.findMergedFor(
      turn.sessionId as string,
      turnId as string,
    );
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
}
