import { describe, it, expect } from 'vitest';
import { ModelCatalog } from '../src/catalog.js';
import type { ModelEntry } from '../src/catalog.js';

const makeEntry = (overrides: Partial<ModelEntry> & Pick<ModelEntry, 'provider' | 'model'>): ModelEntry => ({
  displayName: overrides.model,
  capabilities: { chat: true, tools: false, vision: false, jsonMode: false, streaming: true, promptCache: false },
  contextWindow: 4096,
  isStatic: true,
  ...overrides,
});

describe('ModelCatalog — static preset', () => {
  it('list() returns bundled models', () => {
    const cat = new ModelCatalog();
    expect(cat.list().length).toBeGreaterThan(5);
  });

  it('every entry has required fields', () => {
    for (const e of new ModelCatalog().list()) {
      expect(e.provider).toBeTruthy();
      expect(e.model).toBeTruthy();
      expect(e.displayName).toBeTruthy();
      expect(e.contextWindow).toBeGreaterThan(0);
    }
  });

  it('get() finds gpt-4o', () => {
    const e = new ModelCatalog().get('openai-llm', 'gpt-4o');
    expect(e?.displayName).toBe('GPT-4o');
    expect(e?.capabilities.vision).toBe(true);
    expect(e?.capabilities.tools).toBe(true);
  });

  it('get() finds claude-sonnet-4-5 with promptCache', () => {
    const e = new ModelCatalog().get('anthropic-llm', 'claude-sonnet-4-5');
    expect(e?.capabilities.promptCache).toBe(true);
  });

  it('get() returns undefined for unknown model', () => {
    expect(new ModelCatalog().get('openai-llm', 'gpt-3')).toBeUndefined();
  });

  it('get() returns undefined for wrong provider', () => {
    expect(new ModelCatalog().get('anthropic-llm', 'gpt-4o')).toBeUndefined();
  });
});

describe('ModelCatalog — upsert', () => {
  it('adds a new model', () => {
    const cat = new ModelCatalog();
    cat.upsert([makeEntry({ protocol: 'openai-llm', model: 'my-model', displayName: 'My Model' })]);
    expect(cat.get('openai-llm', 'my-model')?.displayName).toBe('My Model');
  });

  it('overwrites an existing model', () => {
    const cat = new ModelCatalog();
    cat.upsert([makeEntry({ protocol: 'openai-llm', model: 'gpt-4o', displayName: 'Overridden' })]);
    expect(cat.get('openai-llm', 'gpt-4o')?.displayName).toBe('Overridden');
  });

  it('same model name under different providers is independent', () => {
    const cat = new ModelCatalog([
      makeEntry({ protocol: 'openai-llm',     model: 'shared', displayName: 'OpenAI' }),
      makeEntry({ protocol: 'anthropic-llm',  model: 'shared', displayName: 'Anthropic' }),
    ]);
    expect(cat.get('openai-llm',    'shared')?.displayName).toBe('OpenAI');
    expect(cat.get('anthropic-llm', 'shared')?.displayName).toBe('Anthropic');
  });

  it('list() includes upserted entries', () => {
    const cat = new ModelCatalog([]);
    cat.upsert([
      makeEntry({ protocol: 'gemini-llm', model: 'a' }),
      makeEntry({ protocol: 'gemini-llm', model: 'b' }),
    ]);
    expect(cat.list()).toHaveLength(2);
  });
});

describe('ModelCatalog — custom initial list', () => {
  it('constructor accepts empty array', () => {
    expect(new ModelCatalog([]).list()).toHaveLength(0);
  });

  it('constructor accepts partial list', () => {
    const cat = new ModelCatalog([makeEntry({ protocol: 'gemini-llm', model: 'test' })]);
    expect(cat.list()).toHaveLength(1);
    expect(cat.get('gemini-llm', 'test')).toBeDefined();
  });
});
