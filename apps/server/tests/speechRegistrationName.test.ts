import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Character, CharacterStore } from '@ema-agent/characters';
import type { ModelBindings, Providers } from '@ema-agent/providers';
import { Database } from '@ema-agent/storage';
import { UsageRecorder } from '@ema-agent/usage';
import { openSpeech } from '../src/composition/speech.js';
import { providerCapabilitiesRoute } from '../src/routes/providers/capabilities.js';

const MODEL_ID = 'FunAudioLLM/CosyVoice2-0.5B';
const PROVIDER_ID = 'siliconflow-test';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Speech 参考音频注册名称', () => {
  it.each([
    ['樱羽艾玛', '主参考.wav'],
    ['艾玛', '参考音频'.repeat(18) + '.wav'],
    ['Ema 测试角色', 'reference !@#.wav'],
  ])('Provider 试听使用合规注册名且重复试听复用音色: %s / %s', async (characterName, resourceName) => {
    const directory = await mkdtemp(join(tmpdir(), 'ema-speech-registration-'));
    const database = new Database({ memory: true, kind: 'data' });
    try {
      database.migrate();
      const audioPath = join(directory, 'reference.wav');
      await writeFile(audioPath, Buffer.from([1, 2, 3]));
      const character: Character = {
        name: characterName,
        displayName: null,
        description: null,
        personaPrompt: '角色测试',
        stageKind: 'blank',
        live2dModels: [],
        illustrations: [],
        voiceSamples: [{
          name: resourceName,
          characterName,
          displayName: '参考声音',
          isPrimary: true,
          mimeType: 'audio/wav',
          byteSize: 3,
          durationMs: 1_000,
          promptText: '参考文本',
          promptLang: 'zh',
          createdAt: 1,
          updatedAt: 1,
        }],
        isActive: true,
        lastActivatedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      const resolveVoiceSampleFile = vi.fn(() => audioPath);
      const characters = {
        current: () => character,
        resolveVoiceSampleFile,
      } as unknown as CharacterStore;
      const providers = {
        resolveConnection: () => ({
          providerId: PROVIDER_ID,
          protocol: 'siliconflow-tts',
          baseUrl: 'https://tts.test/v1',
          apiKey: 'test-key',
        }),
      } as unknown as Providers;
      const bindings = { get: () => undefined } as unknown as ModelBindings;
      const uploads: FormData[] = [];
      const synthesisVoices: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/uploads/audio/voice')) {
          const form = init.body as FormData;
          uploads.push(form);
          const name = String(form.get('customName'));
          // 按供应商的名称限制拒绝输入, 避免 mock 放过中文或超长注册名.
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
            return Response.json({ code: 20048, message: 'Invalid custom name' }, { status: 400 });
          }
          return Response.json({ uri: 'speech:test-voice' });
        }
        expect(url).toBe('https://tts.test/v1/audio/speech');
        const request = JSON.parse(String(init.body)) as { model: string; voice: string };
        expect(request.model).toBe(MODEL_ID);
        synthesisVoices.push(request.voice);
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: { 'content-type': 'audio/mpeg' },
        });
      }));
      const speech = openSpeech(
        database,
        directory,
        new UsageRecorder(database),
        providers,
        bindings,
        characters,
        () => {},
      );
      const route = providerCapabilitiesRoute(speech);
      for (let index = 0; index < 2; index += 1) {
        const response = await route.request(`/${PROVIDER_ID}/tts-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelId: MODEL_ID, text: '你好呀' }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('audio/mpeg');
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([4, 5, 6]);
      }
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.get('customName')).toMatch(/^ema-[0-9a-f-]{36}$/);
      expect(uploads[0]!.get('model')).toBe(MODEL_ID);
      expect((uploads[0]!.get('file') as File).name).toBe(resourceName);
      expect(uploads[0]!.get('text')).toBe('参考文本');
      expect(synthesisVoices).toEqual(['speech:test-voice', 'speech:test-voice']);
      expect(resolveVoiceSampleFile).toHaveBeenCalledWith(characterName, resourceName);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
