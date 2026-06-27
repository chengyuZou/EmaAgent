import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import { createVectorIndex } from './factory.js';
import { rebuildNodesIndex, rebuildItemsIndex } from './rebuild.js';
import type { VectorIndex } from './vector-index.js';

export class IndexManager {
  nodesIndex: VectorIndex | null = null;
  itemsIndex: VectorIndex | null = null;

  constructor(
    private readonly deps:  MemoryDeps,
    private readonly embed: EmbedService,
  ) {}

  async initialize(): Promise<{ nodes: number; items: number; backend: string | null }> {
    if (this.nodesIndex || this.itemsIndex) {
      return {
        nodes:   this.nodesIndex?.size() ?? 0,
        items:   this.itemsIndex?.size() ?? 0,
        backend: this.nodesIndex?.backend ?? this.itemsIndex?.backend ?? null,
      };
    }

    const p = this.embed.resolveEmbed();
    if (!p) return { nodes: 0, items: 0, backend: null };

    const dim = this.deps.getEmbedDim(p.model);
    if (!dim) return { nodes: 0, items: 0, backend: null };

    const t0 = Date.now();
    this.nodesIndex = await createVectorIndex(dim);
    this.itemsIndex = await createVectorIndex(dim);

    const nodes = rebuildNodesIndex(this.nodesIndex, this.deps.nodes, p.model);
    const items = rebuildItemsIndex(this.itemsIndex, this.deps.items, p.model);

    this.deps.emit?.({
      type:       'memory_index_rebuilt',
      backend:    this.nodesIndex.backend,
      nodes,
      items,
      durationMs: Date.now() - t0,
    });

    return { nodes, items, backend: this.nodesIndex.backend };
  }

  async refreshIndexes(): Promise<void> {
    this.nodesIndex = null;
    this.itemsIndex = null;
    await this.initialize();
  }

  upsertNode(id: string, vec: Float32Array): void { this.nodesIndex?.update(id, vec); }
  removeNode(id: string): void                    { this.nodesIndex?.remove(id); }
  upsertItem(id: string, vec: Float32Array): void { this.itemsIndex?.update(id, vec); }
  removeItem(id: string): void                    { this.itemsIndex?.remove(id); }

  stats(): {
    nodes: { size: number; backend: string } | null;
    items: { size: number; backend: string } | null;
  } {
    return {
      nodes: this.nodesIndex ? { size: this.nodesIndex.size(), backend: this.nodesIndex.backend } : null,
      items: this.itemsIndex ? { size: this.itemsIndex.size(), backend: this.itemsIndex.backend } : null,
    };
  }
}
