// 解析 models.dev 目录建议；缺失字段保持未知，不冒充运行时模型事实。
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
 * provider_capabilities.models_dev_id)为索引,这样配置好的 EmaAgent provider 能解析到
 * 对应的 models.dev provider。models.dev 未收录的 provider(本地运行时、
 * 仅 embed/rerank/tts)没有条目,回退到 provider 自己的 `/models` endpoint 或手填。
 *
 * ModelsDevCatalog 是纯解析器；models-dev.json 本地快照的读盘与刷新归本文件底部的
 * getModelsDevCatalog/refreshModelsDevCatalog（快照是拉取产物，gitignored 不入库）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchPublicResource } from '@ema-agent/public-http';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

export interface ModelsDevSpec {
  id:                string;
  /** 模型显示名（api.json 的 name 字段）；预填 provider_models.name 用。 */
  name?:             string;
  /** 上下文窗口(token)。models.dev 未声明时 undefined。 */
  contextWindow?:    number;
  /** 最大输出 token。未声明时 undefined。 */
  maxOutput?:        number;
  /** 输入模态,如 ['text','image','file']。 */
  inputModalities:   string[];
  /** 输出模态,如 ['text'] 或 ['image']。 */
  outputModalities:  string[];
  toolCall?:         boolean;
  reasoning?:        boolean;
  /** false -> 模型拒绝 `temperature`(o-series / reasoning 模型)。 */
  temperature?:      boolean;
  inputImage?:       boolean;
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
  /** modelsDevId -> (modelId -> spec)。能力/窗口查询必须走 Provider + Model 精确身份。 */
  private readonly index = new Map<string, Map<string, ModelsDevSpec>>();

  /** 解析 models.dev api.json payload。对缺失/多余字段容错。 */
  loadFromJson(payload: unknown): void {
    const providers = asRecord(payload);
    if (!providers) return;

    const next     = new Map<string, Map<string, ModelsDevSpec>>();
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
          name:             typeof m['name'] === 'string' ? m['name'] : undefined,
          contextWindow:    limit ? asNumber(limit['context']) : undefined,
          maxOutput:        limit ? asNumber(limit['output'])  : undefined,
          inputModalities:  modalities ? asStringArray(modalities['input'])  : [],
          outputModalities: modalities ? asStringArray(modalities['output']) : [],
          toolCall:         asBoolean(m['tool_call']),
          reasoning:        asBoolean(m['reasoning']),
          temperature:      asBoolean(m['temperature']),
          inputImage:       modalities
            ? asStringArray(modalities['input']).includes('image')
            : undefined,
        };
        modelMap.set(modelId, spec);
      }
      if (modelMap.size > 0) next.set(providerId, modelMap);
    }

    // 整体替换 - refresh 总是反映最新快照。
    this.index.clear();
    for (const [k, v] of next) this.index.set(k, v);
  }

  /** 
  * 单个模型在不同的供应商里参数不一定全部相同 
  * 在调用时，必须使用 providerId + modelId 精确身份查询能力/窗口。
  */
  get(modelsDevId: string, modelId: string): ModelsDevSpec | undefined {
    return this.index.get(modelsDevId)?.get(modelId);
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

  /** 已收录的模型条目总数(跨 provider 求和),仅用于"目录是否为空"判断与日志。 */
  get size(): number {
    let total = 0;
    for (const models of this.index.values()) total += models.size;
    return total;
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ── 本地快照的加载与刷新 ─────────────────────────────────────────────────────
// models-dev.json 是 api.json 的本地缓存（gitignored，拉取产物不入库）；
// get 惰性读盘一次，refresh 有更新才覆写并重载。快照缺失时 get 返回空目录，
// 模型发现回退到 live fetch 与手填，不阻塞主链路。

const SNAPSHOT_PATH = fileURLToPath(new URL('./models-dev.json', import.meta.url));

let cached: ModelsDevCatalog | undefined;

export function getModelsDevCatalog(): ModelsDevCatalog {
  if (cached) return cached;
  const catalog = new ModelsDevCatalog();
  try {
    catalog.loadFromJson(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')));
  } catch {
    // 首次运行或文件损坏：空目录，由 refresh 补齐
  }
  cached = catalog;
  return catalog;
}

/** 拉取 models.dev 最新目录；内容有变化才覆写快照并重载内存。返回是否有更新。 */
export async function refreshModelsDevCatalog(signal?: AbortSignal): Promise<boolean> {
  const response = await fetchPublicResource(MODELS_DEV_API_URL, {
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  const text = response.body.toString('utf8');
  let previous = '';
  try {
    previous = readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch {
    // 首次运行：没有旧快照可比，直接写入
  }
  if (previous === text) return false;
  writeFileSync(SNAPSHOT_PATH, text, 'utf8');
  const catalog = new ModelsDevCatalog();
  catalog.loadFromJson(JSON.parse(text));
  cached = catalog;
  return true;
}
