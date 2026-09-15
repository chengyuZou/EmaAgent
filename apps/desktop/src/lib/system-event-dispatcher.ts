// 将跨窗口事件交给各业务处理器和当前窗口已挂载的查询视图。

import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import { handleBackgroundProcessSystemEvent } from '../stores/backgroundProcess.js';
import { handleCharacterSystemEvent } from '../stores/character.js';
import { handleKnowledgeSystemEvent } from '../stores/knowledge.js';
import { handleSettingsSystemEvent } from '../stores/settings.js';
import { handleSkillSystemEvent } from '../stores/skill.js';
import { handleMcpSystemEvent } from '../stores/mcp.js';
import { handleTaskSystemEvent } from '../stores/task.js';

const listeners = new Set<(event: AppEvent) => void>();

export function subscribeSystemEvent(listener: (event: AppEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function dispatchSystemEvent(event: AppEvent): void {
  handleCharacterSystemEvent(event);
  handleKnowledgeSystemEvent(event);
  handleBackgroundProcessSystemEvent(event);
  handleSettingsSystemEvent(event);
  handleSkillSystemEvent(event);
  handleMcpSystemEvent(event);
  handleTaskSystemEvent(event);
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[system-events] 业务监听失败:', error);
    }
  }
}
