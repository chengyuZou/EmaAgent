// 测试内置 Provider 预设的身份、协议和模型建议满足控制面约束。
import { describe, expect, it } from 'vitest';
import {
  getCapabilityDefinition,
  listProviderCapabilities,
  providerCatalog,
  staticModelsFor,
} from '../index.js';

describe('Provider Definition 目录', () => {
  it('内置身份唯一且可按 ID 取回', () => {
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

  it('每项能力至少声明一条同族协议且没有重复', () => {
    for (const definition of providerCatalog.list()) {
      for (const capability of listProviderCapabilities(definition)) {
        const transports = getCapabilityDefinition(definition, capability)!.transports;
        const protocols = transports.map((transport) => transport.protocol);
        expect(protocols.length, `${definition.id}/${capability}`).toBeGreaterThan(0);
        expect(new Set(protocols).size, `${definition.id}/${capability}`).toBe(protocols.length);
        expect(protocols.every((protocol) => protocol.endsWith(`-${capability}`))).toBe(true);
      }
    }
  });

  it('预设地址有效且静态模型建议没有空值或重复项', () => {
    for (const definition of providerCatalog.list()) {
      if (definition.connection.defaultBaseUrl) {
        expect(() => new URL(definition.connection.defaultBaseUrl!)).not.toThrow();
      }
      for (const capability of listProviderCapabilities(definition)) {
        const models = staticModelsFor(definition, capability);
        expect(new Set(models).size, `${definition.id}/${capability}`).toBe(models.length);
        expect(models.every((model) => model.trim().length > 0)).toBe(true);
      }
    }
  });
});
