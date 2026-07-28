// 在 LocalHost 组合根中构造 Turn HTTP 路由所需的窄执行和查询能力。

import type { Hono } from 'hono';
import { turnsRoute } from '../routes/turns/index.js';
import type { AppBindings } from './bindings.js';
import { createTurnExecution } from './createTurnExecution.js';
import { createTurnOutput } from './createTurnOutput.js';

export function createTurnsRouter(bindings: AppBindings): Hono {
  const {
    executor,
    inputPreparer,
  } = createTurnExecution(bindings);
  const speechOutput = createTurnOutput(bindings);

  return turnsRoute(
    {
      fileAccess: bindings.fileAccess,
      session: bindings.session,
      executor,
      inputPreparer,
      speechOutput,
    },
    bindings.interactionQueue,
    {
      session: bindings.session,
      toolExecutionJournal: bindings.toolExecutionJournal,
    },
    {
      session: bindings.session,
      audioArchive: bindings.audioArchive,
    },
    executor,
  );
}

