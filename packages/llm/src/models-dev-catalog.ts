/**
 * models.dev catalog - 从 https://models.dev/api.json 拉取 LLM/Vision 模型事实,
 * 而非硬编码上下文窗口和能力标志。
 *
 * api.json 结构(已对照 models.dev 构建验证):
 *   { [providerId]: { ...provider 字段, models: { [modelId]: ModelSpec } } }
 *   ModelSpec: { id, name, reasoning, tool_call, temperature, structured_output?,
 *               modalities: { input: string[], output: string[] }, limit: { context, output? } }
 *
 * 以 `modelsDevId`(provider 的 models.dev 文件夹 id - 见
 * Provider capability 的 models-dev source)为索引,这样配置好的 EmaAgent provider 能解析到
 * 对应的 models.dev provider。models.dev 未收录的 provider(本地运行时、
 * 仅 embed/rerank/tts)没有条目,回退到 provider 自己的 `/models` endpoint 或手填。
 *
 * 纯逻辑:无 fs,除可注入的 fetch 外无硬编码 I/O。apps/core 负责缓存持久化
 * (把原始 payload 写盘,启动时 re-`loadFromJson`)和启动后台 `refresh()`。
 */

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

export interface ModelsDevSpec {
  id:                string;
  /** 上下文窗口(token)。models.dev 未声明时 undefined。 */
  contextWindow?:    number;
  /** 最大输出 token。未声明时 undefined。 */
  maxOutput?:        number;
  /** 输入模态,如 ['text','image','file']。 */
  inputModalities:   string[];
  /** 输出模态,如 ['text'] 或 ['image']。 */
  outputModalities:  string[];
  toolCall:          boolean;
  reasoning:         boolean;
  /** false -> 模型拒绝 `temperature`(o-series / reasoning 模型)。 */
  temperature:       boolean;
  structuredOutput:  boolean;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export class ModelsDevCatalog {
  /** modelsDevId -> (modelId -> spec) */
  private readonly index = new Map<string, Map<string, ModelsDevSpec>>();
  /** modelId -> spec - 扁平二级索引,供 O(1) 不分 provider 查询。 */
  private readonly flat  = new Map<string, ModelsDevSpec>();
  private loadedAt: number | null = null;

  /** 解析 models.dev api.json payload。对缺失/多余字段容错。 */
  loadFromJson(payload: unknown): void {
    const providers = asRecord(payload);
    if (!providers) return;

    const next     = new Map<string, Map<string, ModelsDevSpec>>();
    const nextFlat = new Map<string, ModelsDevSpec>();
    for (const [providerId, providerVal] of Object.entries(providers)) {
      const prov = asRecord(providerVal);
      const models = prov && asRecord(prov['models']);
      if (!models) continue;

      const modelMap = new Map<string, ModelsDevSpec>();
      for (const [modelId, modelVal] of Object.entries(models)) {
        const m = asRecord(modelVal);
        if (!m) continue;
        const limit      = asRecord(m['limit']);
        const modalities = asRecord(m['modalities']);
        const spec: ModelsDevSpec = {
          id:               typeof m['id'] === 'string' ? m['id'] : modelId,
          contextWindow:    limit ? asNumber(limit['context']) : undefined,
          maxOutput:        limit ? asNumber(limit['output'])  : undefined,
          inputModalities:  modalities ? asStringArray(modalities['input'])  : [],
          outputModalities: modalities ? asStringArray(modalities['output']) : [],
          toolCall:         m['tool_call'] === true,
          reasoning:        m['reasoning'] === true,
          // temperature 标志缺失 -> 假定支持(大多数 chat 模型接受)。
          temperature:      m['temperature'] !== false,
          structuredOutput: m['structured_output'] === true,
        };
        modelMap.set(modelId, spec);
        // 扁平索引:同一 modelId 首个 provider 条目胜出。
        if (!nextFlat.has(modelId)) nextFlat.set(modelId, spec);
      }
      if (modelMap.size > 0) next.set(providerId, modelMap);
    }

    // 整体替换 - refresh 总是反映最新快照。
    this.index.clear();
    this.flat.clear();
    for (const [k, v] of next) this.index.set(k, v);
    for (const [k, v] of nextFlat) this.flat.set(k, v);
    this.loadedAt = Date.now();
  }

  /**
   * 从 models.dev 拉取 + 解析。成功返回原始 payload(供调用方缓存),
   * 失败返回 null - 保留现有索引。
   */
  async refresh(opts: { fetchFn?: typeof fetch; url?: string; signal?: AbortSignal } = {}): Promise<unknown | null> {
    const doFetch = opts.fetchFn ?? fetch;
    try {
      const res = await doFetch(opts.url ?? MODELS_DEV_API_URL, { signal: opts.signal });
      if (!res.ok) return null;
      const payload: unknown = await res.json();
      this.loadFromJson(payload);
      return payload;
    } catch {
      return null;
    }
  }

  get(modelsDevId: string, modelId: string): ModelsDevSpec | undefined {
    return this.index.get(modelsDevId)?.get(modelId);
  }

  /** 通过扁平二级索引做不分 provider 的 spec 查询。O(1)。 */
  getByModelId(modelId: string): ModelsDevSpec | undefined {
    return this.flat.get(modelId);
  }

  /** 模型的上下文窗口,按裸 model id 查找。 */
  contextWindowOf(modelId: string): number | undefined {
    return this.flat.get(modelId)?.contextWindow;
  }

  /** 模型的最大输出 token,按裸 model id 查找。 */
  maxOutputOf(modelId: string): number | undefined {
    return this.flat.get(modelId)?.maxOutput;
  }

  /** 模型是否标记为具备 reasoning 能力。 */
  hasReasoning(modelId: string): boolean {
    return this.flat.get(modelId)?.reasoning === true;
  }

  /**
   * 不分 provider 的模糊建议(供模型名输入的设置 UI)。
   * 返回 id 含 `query` 的 LLM 模型 id 及其上下文窗口。
   * 跨 provider 去重(首个 context 胜出)。
   */
  suggest(query: string, limit = 8): Array<{ id: string; contextWindow: number }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ id: string; contextWindow: number }> = [];
    for (const spec of this.flat.values()) {
      if (!spec.id.toLowerCase().includes(q)) continue;
      // 仅 LLM 类:输出 text(跳过纯图像/视频生成)。
      if (spec.outputModalities.length > 0 && !spec.outputModalities.includes('text')) continue;
      results.push({ id: spec.id, contextWindow: spec.contextWindow ?? 0 });
      if (results.length >= limit) break;
    }
    return results;
  }

  /** models.dev 为该 provider 列出的全部模型 id。 */
  listModelIds(modelsDevId: string): string[] {
    return [...(this.index.get(modelsDevId)?.keys() ?? [])];
  }

  /** Chat/LLM 模型 id - 输出含 'text'(排除纯图像/视频生成)。 */
  listLlmModelIds(modelsDevId: string): string[] {
    const map = this.index.get(modelsDevId);
    if (!map) return [];
    return [...map.values()]
      .filter(s => s.outputModalities.length === 0 || s.outputModalities.includes('text'))
      .map(s => s.id);
  }

  /** Vision 模型 id - 输出含 'text' 且输入含 'image'。 */
  listVisionModelIds(modelsDevId: string): string[] {
    const map = this.index.get(modelsDevId);
    if (!map) return [];
    return [...map.values()]
      .filter(s =>
        (s.outputModalities.length === 0 || s.outputModalities.includes('text')) &&
        s.inputModalities.includes('image'),
      )
      .map(s => s.id);
  }

  /** Vision 门禁:该 LLM 是否接受图像输入?驱动 orchestrator 回退。 */
  supportsImageInput(modelsDevId: string, modelId: string): boolean {
    // 能力门禁必须使用 Provider + Model 精确身份；同名模型禁止跨 Provider 回退。
    return this.get(modelsDevId, modelId)?.inputModalities.includes('image') ?? false;
  }

  get size(): number {
    return this.flat.size;
  }

  get lastLoadedAt(): number | null {
    return this.loadedAt;
  }
}
