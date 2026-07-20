// 测试内置 Provider 目录的身份、能力、协议、地址与模型来源满足可装配约束。
import { describe, expect, it } from 'vitest';
import {
  listProviderCapabilities,
  modelSourcesFor,
  protocolsForCapability,
  providerCatalog,
} from '../src/index.js';

describe('ProviderCatalogFacade', () => {
  it('目录身份唯一且可按 ID 完整取回', () => {
    const definitions = providerCatalog.list();
    const ids = definitions.map((definition) => definition.id);

    expect(definitions).toHaveLength(19);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of definitions) {
      expect(providerCatalog.get(definition.id)).toBe(definition);
      expect(definition.branding.iconId.length).toBeGreaterThan(0);
      expect(listProviderCapabilities(definition).length).toBeGreaterThan(0);
    }
  });

  it('每项能力至少声明一条匹配的协议且没有重复', () => {
    for (const definition of providerCatalog.list()) {
      for (const capability of listProviderCapabilities(definition)) {
        const protocols = protocolsForCapability(definition, capability);
        expect(protocols.length, `${definition.id}/${capability}`).toBeGreaterThan(0);
        expect(new Set(protocols).size, `${definition.id}/${capability}`).toBe(protocols.length);
        for (const protocol of protocols) {
          expect(protocol.endsWith(`-${capability}`), `${definition.id}/${protocol}`).toBe(true);
        }
      }
    }
  });

  it('连接地址有效且静态模型目录没有空值或重复项', () => {
    for (const definition of providerCatalog.list()) {
      if (definition.connection.defaultBaseUrl) {
        expect(() => new URL(definition.connection.defaultBaseUrl!)).not.toThrow();
      }
      for (const capability of listProviderCapabilities(definition)) {
        for (const source of modelSourcesFor(definition, capability)) {
          if (source.type !== 'static') continue;
          expect(source.models.length, `${definition.id}/${capability}`).toBeGreaterThan(0);
          expect(new Set(source.models).size, `${definition.id}/${capability}`).toBe(source.models.length);
          expect(source.models.every((model) => model.trim().length > 0)).toBe(true);
        }
      }
    }
  });
});
