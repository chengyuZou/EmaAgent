// MCP 的 JSON 导入对话框与添加/编辑服务器对话框:状态自包含,主装配只负责开关。
import { useState, type CSSProperties, type JSX } from 'react';
import {
  Badge, Button, Callout, Dialog, Divider, Field, Input, Select, Textarea, ToolSpecItem,
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import type { McpServerItem, McpProbeResult, McpImportResult } from '../../api/mcp.js';
import { showToast } from '../../lib/toast.js';
import { McpArgumentEditor } from './McpArgumentEditor.js';
import { KeyValueEditor, type McpKeyValuePair } from './KeyValueEditor.js';
import { toolParamNames } from './McpServerRow.js';
import type { McpServerConfig } from '../../api/mcp.js';

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'Stdio(本地进程)' },
  { value: 'http',  label: 'Streamable HTTP'  },
];

// ── 表单 ↔ 后端配置的无损双向转换（仅本文件消费） ──────────────────────────────

type McpTransportType = NonNullable<McpServerConfig['type']>;

interface McpServerFormState {
  name: string;
  transport: McpTransportType;
  command: string;
  args: string[];
  url: string;
  env: McpKeyValuePair[];
  headers: McpKeyValuePair[];
}

function createEmptyMcpFormState(): McpServerFormState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    env: [],
    headers: [],
  };
}

function mcpPairsToRecord(
  pairs: McpKeyValuePair[],
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) result[key.trim()] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mcpRecordToPairs(
  record: Record<string, string> | undefined,
): McpKeyValuePair[] {
  return record
    ? Object.entries(record).map(([key, value]) => ({ key, value }))
    : [];
}

function buildMcpServerConfig(form: McpServerFormState): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      // argv 的每个元素都有独立语义，空格、引号、反斜杠与空字符串均原样保留。
      args: [...form.args],
      env: mcpPairsToRecord(form.env),
    };
  }

  return {
    type: 'http',
    url: form.url.trim(),
    headers: mcpPairsToRecord(form.headers),
  };
}

function mcpServerConfigToForm(
  name: string,
  config: McpServerConfig,
): McpServerFormState {
  // http 变体的 type 是必填字面量,用它做判别;stdio 的 type 在输入侧可缺省。
  if (config.type === 'http') {
    return {
      name,
      transport: 'http',
      command: '',
      args: [],
      url: config.url,
      env: [],
      headers: mcpRecordToPairs(config.headers),
    };
  }

  return {
    name,
    transport: 'stdio',
    command: config.command,
    args: [...(config.args ?? [])],
    url: '',
    env: mcpRecordToPairs(config.env),
    headers: [],
  };
}

// ── Import from JSON dialog ───────────────────────────────────────────────────

export function McpImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [importJson,    setImportJson]    = useState('');
  const [importing,     setImporting]     = useState(false);
  const [importError,   setImportError]   = useState<string | null>(null);
  const [importResults, setImportResults] = useState<McpImportResult['items'] | null>(null);

  function closeImport(): void {
    onOpenChange(false);
    setImportJson('');
    setImportError(null);
    setImportResults(null);
  }

  async function handleImport(): Promise<void> {
    const trimmed = importJson.trim();
    if (!trimmed) return;
    let payload: object;
    try {
      payload = JSON.parse(trimmed) as object;
    } catch {
      setImportError('JSON 格式错误，请检查后重试');
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportResults(null);
    try {
      const results = await useMcpStore.getState().importFromJson(payload);
      setImportResults(results);
      const ok    = results.filter((r) => r.ok).length;
      const total = results.length;
      showToast(`已导入 ${ok}/${total} 个服务器`, { variant: ok > 0 ? 'success' : 'warning' });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) closeImport(); }}
      title="从 JSON 导入 MCP 服务器"
      description="粘贴 Claude Desktop 或 mcp.so 格式的 JSON 配置，支持批量导入多个服务器。"
      widthClass="max-w-2xl"
    >
      {importError && <Callout variant="danger" className="mb-3">{importError}</Callout>}

      {importResults ? (
        <div className="flex flex-col gap-2">
          {importResults.map((r, i) => (
            <div
              key={r.name}
              className="flex items-start gap-3 px-3 py-2 rounded-lg
                         border-2 border-solid border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-stagger-in ema-card-decorate ema-card-decorate--circuit hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]"
              style={{ '--stagger-i': i } as CSSProperties}
            >
              <Badge variant={r.ok ? 'success' : 'danger'} dot className="mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{r.name}</span>
                  <Badge variant={r.ok ? 'success' : 'danger'}>{r.ok ? '成功' : '失败'}</Badge>
                </div>
                {!r.ok && (
                  <p className="text-xs text-[var(--ema-danger)] mt-0.5">{r.error}</p>
                )}
                {r.ok && 'connectError' in r && r.connectError && (
                  <p className="text-xs text-[var(--ema-warning)] mt-0.5">连接警告：{r.connectError}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Field label="JSON 配置" required description='格式：{ "mcpServers": { "服务器名": { "command": "...", "args": [...] } } }'>
          <Textarea
            minRows={8}
            maxRows={16}
            placeholder={'{\n  "mcpServers": {\n    "brave-search": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-brave-search"]\n    }\n  }\n}'}
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            className="font-mono text-xs"
          />
        </Field>
      )}

      <div className="flex justify-end gap-2 mt-4">
        {importResults ? (
          <Button variant="primary" size="sm" onClick={closeImport}>完成</Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={closeImport}>取消</Button>
            <Button
              variant="primary"
              size="sm"
              loading={importing}
              disabled={!importJson.trim() || importing}
              onClick={() => void handleImport()}
            >导入</Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ── Add / edit-server dialog ──────────────────────────────────────────────────

export function McpServerFormDialog({
  open,
  editing,
  onOpenChange,
}: {
  open: boolean;
  /** 编辑目标;null 表示新建。父级以 key 区分实例,切换时整体重挂重置表单。 */
  editing: McpServerItem | null;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [form, setForm] = useState(() =>
    editing ? mcpServerConfigToForm(editing.name, editing.config) : createEmptyMcpFormState());
  const [probeResult, setProbeResult] = useState<McpProbeResult | null>(null);
  const [probing,   setProbing]   = useState(false);
  const [adding,    setAdding]    = useState(false);
  const [addError,  setAddError]  = useState<string | null>(null);

  const formValid = form.name.trim() &&
    (form.transport === 'stdio' ? form.command.trim() : form.url.trim());

  function closeAdd(): void {
    onOpenChange(false);
  }

  async function handleProbe(): Promise<void> {
    setProbing(true);
    setProbeResult(null);
    try {
      const serverName = form.name.trim() || '未命名 MCP';
      const result = await useMcpStore.getState().probe(serverName, buildMcpServerConfig(form));
      setProbeResult(result);
    } catch (err) {
      setProbeResult({
        ok: false,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProbing(false);
    }
  }

  async function handleAdd(): Promise<void> {
    if (!form.name.trim()) { setAddError('名称不能为空'); return; }
    setAdding(true);
    setAddError(null);
    try {
      // register() upserts by name; editing re-registers + connects so the new
      // env/headers (API keys, Bearer token) take effect immediately.
      await useMcpStore.getState().register(form.name.trim(), buildMcpServerConfig(form), undefined, true);
      showToast(editing ? `已更新 ${form.name}` : `已注册 ${form.name}`, { variant: 'success' });
      closeAdd();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) closeAdd(); }}
      title={editing ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
      description="注册后自动尝试连接。远程服务器在 Headers 填鉴权，本地进程在环境变量填 API Key。"
      widthClass="max-w-lg"
    >
      {addError && <Callout variant="danger" className="mb-3">{addError}</Callout>}

      <div className="flex flex-col gap-3">
        <Field label="服务器名称" required>
          <Input
            placeholder="my-server"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            disabled={!!editing}
            autoFocus={!editing}
          />
        </Field>

        <Field label="传输类型" required>
          <Select
            value={form.transport}
            onChange={(v) => setForm({ ...form, transport: v as McpTransportType })}
            options={TRANSPORT_OPTIONS}
          />
        </Field>

        {form.transport === 'stdio' ? (
          <>
            <Field label="可执行文件" required>
              <Input
                placeholder="uvx / npx / /path/to/binary"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
            </Field>
            <Field label="参数" description="每一项都会作为独立 argv 参数传给进程，不进行 Shell 解析">
              <McpArgumentEditor
                value={form.args}
                onChange={(args) => setForm({ ...form, args })}
              />
            </Field>
            <Field label="环境变量" description="API Key 等，如 AMAP_MAPS_API_KEY">
              <KeyValueEditor
                pairs={form.env}
                onChange={(env) => setForm({ ...form, env })}
                keyPlaceholder="AMAP_MAPS_API_KEY"
                valuePlaceholder="api_key"
                secret
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="服务器 URL" required>
              <Input
                placeholder="http://localhost:3000/mcp"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            </Field>
            <Field label="请求头 Headers" description="鉴权等，如 Authorization: Bearer …">
              <KeyValueEditor
                pairs={form.headers}
                onChange={(headers) => setForm({ ...form, headers })}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer sk-..."
                secret
              />
            </Field>
          </>
        )}

        {probeResult && (
          <Callout variant={probeResult.ok ? 'success' : 'danger'}>
            {probeResult.ok ? '连接测试成功' : `连接失败：${probeResult.error}`}
          </Callout>
        )}

        {probeResult?.ok && probeResult.tools && probeResult.tools.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2 ema-fade-in">
            <span className="text-xs text-[var(--ema-text-tertiary)]">
              发现 {probeResult.tools.length} 个工具：
            </span>
            {probeResult.tools.map((t) => {
              const params = toolParamNames(t.inputSchema);
              return (
                <ToolSpecItem key={t.serverToolName} name={t.serverToolName} params={params} description={t.description} />
              );
            })}
          </div>
        )}
      </div>

      <Divider className="my-4" />

      <div className="flex items-center justify-between">
        <Button
          variant="secondary"
          size="sm"
          loading={probing}
          disabled={!formValid || probing}
          onClick={() => void handleProbe()}
        >测试连接</Button>

        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={closeAdd}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            loading={adding}
            disabled={!formValid || adding}
            onClick={() => void handleAdd()}
          >添加</Button>
        </div>
      </div>
    </Dialog>
  );
}
