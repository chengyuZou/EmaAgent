// 组合模型绑定选择器目录与绑定写入协议，不接触完整应用对象图。
import { Hono } from 'hono';
import type { ModelBindingControl } from '@ema-agent/provider';
import {
  availableBindingModelsRoute,
  type AvailableBindingModelsDependencies,
} from './availableModels.js';
import { modelBindingMutationsRoute } from './modelBindingMutations.js';

export function modelBindingsRoute(
  bindings: ModelBindingControl,
  availableModels: AvailableBindingModelsDependencies,
): Hono {
  const app = new Hono();
  app.route('/', availableBindingModelsRoute(availableModels));
  app.route('/', modelBindingMutationsRoute(bindings));
  return app;
}
