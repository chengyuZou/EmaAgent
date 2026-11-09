import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { SpeechRequestError, type AudioStore, type SpeechGenerator } from '@ema-agent/speech';

export const audioRoute = (
  audioStore: Pick<AudioStore, 'deleteAudio' | 'getAudioPlayback' | 'openRead' | 'outputs'>, 
  speechGenerator: Pick<SpeechGenerator, 'cancelGeneration'>
) => new Hono()
  .get('/:audioId', context => {
    const audioRecord = audioStore.outputs.findByAudioId(context.req.param('audioId'));
    if (!audioRecord) return context.json({ error: 'audio_not_found' }, 404);
    return context.json(audioRecord);
  })
  .get('/:audioId/playback', context => {
    const audioPlayback = audioStore.getAudioPlayback(context.req.param('audioId'));
    if (!audioPlayback) return context.json({ error: 'audio_not_available' }, 404);
    return context.json(audioPlayback);
  })
  .get('/:audioId/file', async context => {
    const audioRead = await audioStore.openRead(context.req.param('audioId'), context.req.raw.signal);
    if (!audioRead) return context.json({ error: 'audio_not_available' }, 404);
    const headers = new Headers({ 'Content-Type': audioRead.mimeType, 'Cache-Control': 'no-store' });
    if (audioRead.byteSize !== null) headers.set('Content-Length', String(audioRead.byteSize));
    return new Response(Readable.toWeb(audioRead.stream) as ReadableStream<Uint8Array>, { headers });
  })
  .post('/:audioId/cancel', async context => {
    await speechGenerator.cancelGeneration(context.req.param('audioId'));
    return context.body(null, 204);
  })
  .delete('/:audioId', async context => {
    try {
      await audioStore.deleteAudio(context.req.param('audioId'));
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof SpeechRequestError) {
        return context.json({ error: error.code, message: error.message }, 409);
      }
      return context.json({
        error: 'speech/audio_delete_failed',
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  });
