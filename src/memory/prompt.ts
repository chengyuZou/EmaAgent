// 产出注入 system prompt 的"记忆使用指引"段（静态模板文本）。
//
// 与 prompts 包解耦:prompts 的 getSystemPrompt 只接收 memorySection 字符串
// (闭包注入),不 import memory 包;本函数在 Turn 装配时被调用。
// 两轨 memory_summary.md 摘要不进 System Prompt——它们表示"本 Turn 开始时的事实",
// 由 Turn 在启动时读取一次并写进持久化 reminder（kind='reminder'）。

import { loadTemplate } from './templates/loader.js';

/**
 * 记忆使用指引（固定模板）。两轨都没有摘要时也返回指引——Agent 仍知道记忆系统与 Tool。
 */
export async function buildMemoryGuidance(): Promise<string> {
  const guidance = await loadTemplate('memoryGuidance');
  return guidance.trim();
}
