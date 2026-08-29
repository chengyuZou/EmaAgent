// 角色健康与主窗口演出快照：健康门、降级链与当前选中资源的原子投影。
import { Hono } from 'hono';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';

export interface CharacterHealthRouteDeps {
  readonly characters: Pick<
    CharacterStore,
    | 'inspectHealth' | 'inspectAllHealth'
    | 'resolveLive2dModelFile' | 'resolveIllustrationFile' | 'resolveVoiceSampleFile'
    | 'resolveLive2dRuntimeConfig'
  >;
}

export const characterHealthRoute = (deps: CharacterHealthRouteDeps) =>
  new Hono()
    .get('/health', async context => {
      return context.json(await deps.characters.inspectAllHealth());
    })
    .get('/:id/health', async context => {
      try {
        return context.json(await deps.characters.inspectHealth(context.req.param('id')));
      } catch (error) {
        return characterError(context, error);
      }
    })
    // 主窗口消费的原子快照：降级链结果 + 当前选中资源的服务端解析路径与运行配置。
    // 同角色切换保留旧画面、跨角色先占位的展示策略由前端按快照内容执行。
    .get('/:id/presentation', async context => {
      try {
        const health = await deps.characters.inspectHealth(context.req.param('id'));
        const id = context.req.param('id');
        return context.json({
          ...health,
          live2dModelFile: health.selectedLive2dModelId
            ? deps.characters.resolveLive2dModelFile(id, health.selectedLive2dModelId)
            : null,
          live2dRuntimeConfig: health.selectedLive2dModelId
            ? deps.characters.resolveLive2dRuntimeConfig(id, health.selectedLive2dModelId)
            : null,
          illustrationFile: health.selectedIllustrationId
            ? deps.characters.resolveIllustrationFile(id, health.selectedIllustrationId)
            : null,
          voiceSampleFile: health.selectedVoiceSampleId
            ? deps.characters.resolveVoiceSampleFile(id, health.selectedVoiceSampleId)
            : null,
        });
      } catch (error) {
        return characterError(context, error);
      }
    });
