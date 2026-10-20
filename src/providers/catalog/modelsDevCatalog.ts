import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

export interface ModelsDevSpec {
  id: string;
  /** 同步时保存到 provider_models.name, undefined 时界面显示模型 ID. */
  name?: string;
  /** Token 数量, 目录未声明有效正数时为 undefined. */
  contextWindow?: number;
  /** 最大输出 Token 数量, 目录未声明有效正数时为 undefined. */
  maxOutput?: number;
  /** 目录中的输入类型, 如 ['text', 'image', 'file']. */
  inputModalities: string[];
  /** 目录中的输出类型, 如 ['text'] 或 ['image']. */
  outputModalities: string[];
  toolCall?: boolean;
  reasoning?: boolean;
  /** false 表示目录声明不支持 temperature, undefined 表示目录未说明. */
  temperature?: boolean;
  inputImage?: boolean;
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
  // 相同模型 ID 在不同供应商下可能有不同参数, 因此分两层保存.
  private readonly index = new Map<string, Map<string, ModelsDevSpec>>();

  /** 忽略无法识别的条目. 非对象输入保留现有目录, 对象输入替换全部目录内容. */
  loadFromJson(payload: unknown): void {
    const providers = asRecord(payload);
    if (!providers) return;

    const next = new Map<string, Map<string, ModelsDevSpec>>();
    for (const [providerId, providerVal] of Object.entries(providers)) {
      const prov = asRecord(providerVal);
      const models = prov && asRecord(prov['models']);
      if (!models) continue;

      const modelMap = new Map<string, ModelsDevSpec>();
      for (const [modelId, modelVal] of Object.entries(models)) {
        const m = asRecord(modelVal);
        if (!m) continue;
        const limit = asRecord(m['limit']);
        const modalities = asRecord(m['modalities']);
        const spec: ModelsDevSpec = {
          id: typeof m['id'] === 'string' ? m['id'] : modelId,
          name: typeof m['name'] === 'string' ? m['name'] : undefined,
          contextWindow: limit ? asNumber(limit['context']) : undefined,
          maxOutput: limit ? asNumber(limit['output']) : undefined,
          inputModalities: modalities ? asStringArray(modalities['input']) : [],
          outputModalities: modalities ? asStringArray(modalities['output']) : [],
          toolCall: asBoolean(m['tool_call']),
          reasoning: asBoolean(m['reasoning']),
          temperature: asBoolean(m['temperature']),
          inputImage: modalities
            ? asStringArray(modalities['input']).includes('image')
            : undefined,
        };
        modelMap.set(modelId, spec);
      }
      if (modelMap.size > 0) next.set(providerId, modelMap);
    }

    // 保留 catalog 对象本身, 已持有它的 ProviderModels 可以直接使用刷新后的内容.
    this.index.clear();
    for (const [k, v] of next) this.index.set(k, v);
  }

  get(modelsDevId: string, modelId: string): ModelsDevSpec | undefined {
    return this.index.get(modelsDevId)?.get(modelId);
  }

  hasProvider(modelsDevId: string): boolean {
    return this.index.has(modelsDevId);
  }

  /** 输出包含 text 或目录未声明输出类型的模型. */
  listLLMModelIds(modelsDevId: string): string[] {
    const map = this.index.get(modelsDevId);
    if (!map) return [];
    return [...map.values()]
      .filter(s => s.outputModalities.length === 0 || s.outputModalities.includes('text'))
      .map(s => s.id);
  }

  /** 在 LLM 筛选条件上额外要求输入包含 image. */
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

  /** 跨供应商的条目总数, 刷新时据此拒绝空目录. */
  get size(): number {
    let total = 0;
    for (const models of this.index.values()) total += models.size;
    return total;
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function loadModelsDevCatalog(filePath: string): ModelsDevCatalog {
  const catalog = new ModelsDevCatalog();
  try {
    catalog.loadFromJson(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    // 缺失或损坏时仍可读取 SQL 中已有的模型, 联网刷新后再补齐目录.
  }
  return catalog;
}

/** 下载完整目录, 保存成功后更新原对象. 文件未变化时也重新装入, SQL 同步由宿主继续执行. */
export async function refreshModelsDevCatalog(catalog: ModelsDevCatalog, filePath: string): Promise<void> {
  const response = await fetch(MODELS_DEV_API_URL, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`models.dev 目录拉取失败(HTTP ${response.status})`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > 8 * 1024 * 1024) {
    throw new Error('models.dev 目录响应体超过 8MB 上限');
  }
  const text = Buffer.from(body).toString('utf8');
  const payload: unknown = JSON.parse(text);
  const parsed = new ModelsDevCatalog();
  parsed.loadFromJson(payload);
  if (parsed.size === 0) {
    throw new Error('models.dev 返回的目录没有可用模型');
  }
  let previous = '';
  try {
    previous = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previous !== text) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  catalog.loadFromJson(payload);
}
