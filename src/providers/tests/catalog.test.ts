// 测试内置 Provider 预设的身份、协议和模型建议满足控制面约束。
import { describe, expect, it } from 'vitest';
import {
  getProviderCapability,
  listProviderCapabilities,
  providerCatalog,
  staticModelsFor,
} from '../index.js';

describe('内置 Provider 预设目录', () => {
  it('内置身份唯一且可按 ID 取回', () => {
    const presets = providerCatalog.list();
    const ids = presets.map((preset) => preset.id);

    expect(presets).toHaveLength(19);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of presets) {
      expect(providerCatalog.get(preset.id)).toBe(preset);
      expect(preset.branding.iconId.length).toBeGreaterThan(0);
      expect(listProviderCapabilities(preset).length).toBeGreaterThan(0);
    }
  });

  it('每项能力至少声明一条同族协议且没有重复', () => {
    for (const preset of providerCatalog.list()) {
      for (const capability of listProviderCapabilities(preset)) {
        const options = getProviderCapability(preset, capability)!.protocols;
        const protocols = options.map((option) => option.protocol);
        expect(protocols.length, `${preset.id}/${capability}`).toBeGreaterThan(0);
        expect(new Set(protocols).size, `${preset.id}/${capability}`).toBe(protocols.length);
        expect(protocols.every((protocol) => protocol.endsWith(`-${capability}`))).toBe(true);
      }
    }
  });

  it('预设地址有效且静态模型建议没有空值或重复项', () => {
    for (const preset of providerCatalog.list()) {
      if (preset.connection.defaultBaseUrl) {
        expect(() => new URL(preset.connection.defaultBaseUrl!)).not.toThrow();
      }
      for (const capability of listProviderCapabilities(preset)) {
        const models = staticModelsFor(preset, capability);
        expect(new Set(models).size, `${preset.id}/${capability}`).toBe(models.length);
        expect(models.every((model) => model.trim().length > 0)).toBe(true);
      }
    }
  });
});
