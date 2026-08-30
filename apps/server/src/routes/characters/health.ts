// 角色健康与主窗口演出视图：健康门与降级链归 /health，舞台渲染条目归 /presentation。
import { Hono } from 'hono';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';

export interface CharacterHealthRouteDeps {
  readonly characters: Pick<
    CharacterStore,
    'inspectHealth' | 'inspectAllHealth' | 'inspectStagePresentation'
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
    // 主窗口消费的原子视图：降级链上每个候选的完整渲染条目，一次返回。
    // 同角色切换保留旧画面、跨角色先占位的展示策略由前端按候选内容执行。
    .get('/:id/presentation', async context => {
      try {
        return context.json(
          await deps.characters.inspectStagePresentation(context.req.param('id')),
        );
      } catch (error) {
        return characterError(context, error);
      }
    });
