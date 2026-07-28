import { Hono } from 'hono';
import type { TurnExecutor } from '@ema-agent/turn-execution';
import { TurnEventHub } from '../../sse/event-hub.js';
import { TurnEventStore } from '../../sse/event-store.js';
import {
  registerAskUserRoutes,
  type AskUserInteractionQueue,
} from './askUser.js';
import {
  registerStartTurnRoute,
  type StartTurnRouteDependencies,
} from './startTurn.js';
import {
  registerTurnAudioRoute,
  type TurnAudioRouteBindings,
} from './turnAudio.js';
import { registerTurnControlRoutes } from './turnControl.js';
import { registerTurnEventRoutes } from './turnEvents.js';
import {
  registerTurnToolsRoute,
  type TurnToolsRouteBindings,
} from './turnTools.js';

export { attachmentInputSchema } from './turnSchemas.js';

export function turnsRoute(
  startTurn: StartTurnRouteDependencies,
  interactionQueue: AskUserInteractionQueue,
  turnTools: TurnToolsRouteBindings,
  turnAudio: TurnAudioRouteBindings,
  executor: Pick<TurnExecutor, 'abort' | 'abortAgentRun' | 'abortTool'>,
): Hono {
  const app = new Hono();
  const eventStore = new TurnEventStore(60_000);
  const eventHub = new TurnEventHub();

  setInterval(() => eventStore.evictExpired(), 30_000).unref?.();

  registerAskUserRoutes(app, interactionQueue);
  registerStartTurnRoute(app, startTurn, eventStore, eventHub);
  registerTurnToolsRoute(app, turnTools);
  registerTurnAudioRoute(app, turnAudio);
  registerTurnEventRoutes(app, eventStore, eventHub);
  registerTurnControlRoutes(app, executor);

  return app;
}
