import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import { createVectorIndex } from './factory.js';
import { rebuildNodesIndex, rebuildItemsIndex } from './rebuild.js';
import type { VectorIndex } from './vector-index.js';

export class IndexManager {
  nodesIndex: VectorIndex | null = null;
  itemsIndex: VectorIndex | null = null;
  private spaceId: string | null = null;
  private initialization: Promise<{
    nodes: number;
    items: number;
    backend: string | null;
  }> | null = null;

  constructor(
    private readonly deps:  MemoryDeps,
    private readonly embed: EmbedService,
  ) {}

  async initialize(): Promise<{ nodes: number; items: number; backend: string | null }> {
    if (this.initialization) return this.initialization;
    const pending = this.initializeCurrentSpace();
    this.initialization = pending;
    try {
      return await pending;
    } finally {
      if (this.initialization === pending) this.initialization = null;
    }
  }

  private async initializeCurrentSpace(): Promise<{
    nodes: number;
    items: number;
    backend: string | null;
  }> {
    const p = this.embed.resolveEmbed();
    if (!p) {
      this.reset();
      return { nodes: 0, items: 0, backend: null };
    }

    const dim = this.deps.getEmbedDim(p.providerId, p.model);
    if (!dim) {
      this.reset();
      return { nodes: 0, items: 0, backend: null };
    }
    const space = this.embed.currentSpace(dim);
    if (!space) {
      this.reset();
      return { nodes: 0, items: 0, backend: null };
    }

    if ((this.nodesIndex || this.itemsIndex) && this.spaceId === space.id) {
      return {
        nodes:   this.nodesIndex?.size() ?? 0,
        items:   this.itemsIndex?.size() ?? 0,
        backend: this.nodesIndex?.backend ?? this.itemsIndex?.backend ?? null,
      };
    }
    this.reset();

    const t0 = Date.now();
    this.nodesIndex = await createVectorIndex(dim);
    this.itemsIndex = await createVectorIndex(dim);

    this.spaceId = space.id;
    const nodes = rebuildNodesIndex(this.nodesIndex, this.deps.nodes, space.id);
    const items = rebuildItemsIndex(this.itemsIndex, this.deps.items, space.id);

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
    this.reset();
    await this.initialize();
  }

  upsertNode(id: string, vec: Float32Array): void { this.nodesIndex?.update(id, vec); }
  removeNode(id: string): void                    { this.nodesIndex?.remove(id); }
  upsertItem(id: string, vec: Float32Array): void { this.itemsIndex?.update(id, vec); }
  removeItem(id: string): void                    { this.itemsIndex?.remove(id); }

  currentSpaceId(): string | null { return this.spaceId; }

  private reset(): void {
    this.nodesIndex = null;
    this.itemsIndex = null;
    this.spaceId = null;
  }

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
