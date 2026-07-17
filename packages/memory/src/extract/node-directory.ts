// 提取期节点目录: 按 (label, type) 精确索引 + 按 label 的全集索引。
// 位于 extract 层, 由 pipeline 从既有节点构建, 新节点登记和边端点解析共用。

import type { MemoryNodeType } from '@ema-agent/storage';

// 复合键分隔符: 不可见控制符, 不会与正常 label 冲突。
const KEY_SEP = '\u0001';

/**
 * B-076: 同名不同 type 的节点(如"苹果(公司)"与"苹果(水果)")在库里合法共存,
 * 边端点必须按 (label, type) 解析; 模型没给 type 时只允许 label 唯一兜底,
 * 同名多节点一律不猜, 防静默连错对象。
 */
export class NodeDirectory {
  private readonly byLabelType = new Map<string, string>();
  private readonly idsByLabel = new Map<string, Set<string>>();

  register(label: string, nodeType: MemoryNodeType, id: string): void {
    this.byLabelType.set(label + KEY_SEP + nodeType, id);
    let set = this.idsByLabel.get(label);
    if (!set) {
      set = new Set();
      this.idsByLabel.set(label, set);
    }
    set.add(id);
  }

  /** 精确 (label, type) 命中。 */
  resolve(label: string, nodeType: MemoryNodeType): string | undefined {
    return this.byLabelType.get(label + KEY_SEP + nodeType);
  }

  /** label 全库唯一时的兜底解析; 同名多节点(歧义)返回 undefined。 */
  resolveUnique(label: string): string | undefined {
    const set = this.idsByLabel.get(label);
    if (!set || set.size !== 1) return undefined;
    return [...set][0];
  }
}
