import { describe, it, expect } from 'vitest';
import { TtsClient } from '../src/service.js';
import type { TtsAdapter, TtsAdapterCall, TtsProviderConfig } from '../src/types.js';
import type { TtsVoiceRef, CharacterVoiceProfile, CharacterRefAudio, TtsStreamEvent } from '@ema-agent/contracts';

// ── Mocks ─────────────────────────────────────────────────────────────────────

function mockProfile(refAudios: CharacterRefAudio[], primaryId?: string): CharacterVoiceProfile {
  return { refAudios, primaryId: primaryId ?? refAudios[0]?.id ?? null };
}

function mockRefAudio(id: string, label: string, refAudioPath: string, promptText = '', promptLang = 'zh'): CharacterRefAudio {
  return { id, label, refAudioPath, promptText, promptLang };
}

function mockProvider(): TtsProviderConfig {
  return { id: 'p1', protocol: 'openai-tts', apiKey: 'sk-test', baseUrl: 'http://localhost' };
}

/** No-op adapter — never actually called in resolveVoice tests */
const noopAdapter: TtsAdapter = {
  protocol: 'openai-tts' as const,
  stream: async function* (_call: TtsAdapterCall): AsyncIterable<TtsStreamEvent> {
    yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
  },
};

// ── Helper to call private resolveVoice ───────────────────────────────────────

function resolveVoice(
  client: TtsClient,
  characterId: string | null,
) {
  return (client as unknown as { resolveVoice: typeof client['resolveVoice'] }).resolveVoice(
    characterId as any,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TtsClient.resolveVoice (V1 clone-only)', () => {
  it('1. card has primary refAudio → returns clone voice spec', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => mockProfile([
          mockRefAudio('r1', 'ema1', 'ema/ema1.mp3', '你好呀', 'zh'),
        ]),
      },
      refPathResolver: {
        resolve: (rel) => `/abs/${rel}`,
      },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, 'ema');

    expect(voice).not.toBeNull();
    if (!voice) throw new Error('unreachable');
    expect(voice.refAudioPath).toBe('/abs/ema/ema1.mp3');
    expect(voice.promptText).toBe('你好呀');
    expect(voice.promptLang).toBe('zh');
    expect(voice.voiceUri).toBeUndefined();
  });

  it('2. card has refAudios but no primaryId → picks first refAudio', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => mockProfile([
          mockRefAudio('r1', 'first', 'ema/first.mp3', '你好', 'zh'),
          mockRefAudio('r2', 'second', 'ema/second.mp3', 'hello', 'en'),
        ], null), // no primaryId
      },
      refPathResolver: { resolve: (rel) => `/abs/${rel}` },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, 'ema');

    expect(voice).not.toBeNull();
    expect(voice!.refAudioPath).toBe('/abs/ema/first.mp3');
    expect(voice!.promptText).toBe('你好');
  });

  it('3. card has multiple refAudios → picks the one with primaryId', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => mockProfile([
          mockRefAudio('r1', 'first', 'ema/first.mp3', '你好', 'zh'),
          mockRefAudio('r2', 'second', 'ema/second.mp3', 'hello', 'en'),
        ], 'r2'),
      },
      refPathResolver: { resolve: (rel) => `/abs/${rel}` },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, 'ema');

    expect(voice).not.toBeNull();
    expect(voice!.refAudioPath).toBe('/abs/ema/second.mp3');
    expect(voice!.promptLang).toBe('en');
  });

  it('4. characterId is null → returns null (system TTS not supported in V1)', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => mockProfile([
          mockRefAudio('r1', 'ema1', 'ema/ema1.mp3', '你好呀', 'zh'),
        ]),
      },
      refPathResolver: { resolve: (rel) => `/abs/${rel}` },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, null);

    expect(voice).toBeNull();
  });

  it('5. card has empty refAudios → returns null', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => mockProfile([]),
      },
      refPathResolver: { resolve: (rel) => `/abs/${rel}` },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, 'ema');

    expect(voice).toBeNull();
  });

  it('6. voiceProfile is null (card not found) → returns null', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => null,
      },
      refPathResolver: { resolve: (rel) => `/abs/${rel}` },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, 'ema');

    expect(voice).toBeNull();
  });

  it('7. primaryId points to non-existent ref → falls back to first refAudio', () => {
    const client = new TtsClient({
      providers: new Map([['p1', mockProvider()]]),
      voiceProfiles: {
        getVoiceProfile: () => mockProfile([
          mockRefAudio('r1', 'first', 'ema/first.mp3', '你好', 'zh'),
        ], 'r999'), // primaryId points to non-existent
      },
      refPathResolver: { resolve: (rel) => `/abs/${rel}` },
      adapterOverrides: new Map([['p1', noopAdapter]]),
    });

    const voice = resolveVoice(client, 'ema');

    expect(voice).not.toBeNull();
    expect(voice!.refAudioPath).toBe('/abs/ema/first.mp3');
  });
});
