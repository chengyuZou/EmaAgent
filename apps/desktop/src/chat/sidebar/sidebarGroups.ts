// 侧栏会话去重辅助；项目分组由服务端五桶分组直接提供，不再做客户端推导。
import type { SidebarSession } from './sidebarFormat.js';

export function uniqueSessions(items: readonly SidebarSession[]): SidebarSession[] {
  const seen = new Set<string>();
  const out: SidebarSession[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
