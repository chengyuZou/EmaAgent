import { useState, type CSSProperties, type JSX } from 'react';
import { MCP_SERVER_NAME_RE } from '@ema-agent/mcp/serverName';
import type { McpAuthType } from '@ema-agent/mcp';
import {
  Badge, Button, Callout, Dialog, Divider, Field, Input, Select, Textarea, ToolSpecItem,
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import type { McpServerSummary, McpProbeResult, McpImportResult } from '../../api/mcp.js';
import { showToast } from '../../lib/notifications/toast.js';
import { McpArgumentEditor } from './McpArgumentEditor.js';
import { KeyValueEditor, type KeyValuePair } from '../shared/KeyValueEditor.js';
import { toolParamNames } from './McpServerRow.js';
import type { McpServerConfig } from '../../api/mcp.js';

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'Stdio(本地进程)' },
  { value: 'http',  label: 'Streamable HTTP'  },
];

const AUTH_TYPE_OPTIONS: { value: McpAuthType; label: string }[] = [
  { value: 'none',  label: '无 / 静态 Headers' },
  { value: 'oauth', label: 'OAuth 2.0 (浏览器授权)' },
];


type McpTransportType = NonNullable<McpServerConfig['type']>;

interface McpServerFormState {
  name: string;
  transport: McpTransportType;
  authType: McpAuthType;
  command: string;
  args: string[];
  url: string;
  env: KeyValuePair[];
  headers: KeyValuePair[];
  envPassthrough: string;
  cwd: string;
  toolTimeoutSec: string;
}

function createEmptyMcpFormState(): McpServerFormState {
  return {
    name: '',
    transport: 'stdio',
    authType: 'none',
    command: '',
    args: [],
    url: '',
    env: [],
    headers: [],
    envPassthrough: '',
    cwd: '',
    toolTimeoutSec: '',
  };
}

function mcpPairsToRecord(
  pairs: KeyValuePair[],
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) result[key.trim()] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mcpRecordToPairs(
  record: Record<string, string> | undefined,
): KeyValuePair[] {
  return record
    ? Object.entries(record).map(([key, value]) => ({ key, value }))
    : [];
}

function buildMcpServerConfig(form: McpServerFormState): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      // argv 的每个元素都有独立语义, 空格, 引号, 反斜杠与空字符串均原样保留.
      args: [...form.args],
      env: mcpPairsToRecord(form.env),
      ...(form.envPassthrough.trim() ? { envPassthrough: form.envPassthrough.split(',').map(value => value.trim()).filter(Boolean) } : {}),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      ...(form.toolTimeoutSec ? { toolTimeoutSec: Number(form.toolTimeoutSec) } : {}),
    };
  }

  return {
    type: 'http',
    url: form.url.trim(),
    headers: mcpPairsToRecord(form.headers),
    ...(form.toolTimeoutSec ? { toolTimeoutSec: Number(form.toolTimeoutSec) } : {}),
  };
}

function mcpServerConfigToForm(
  name: string,
  config: McpServerConfig,
  authType: McpAuthType,
): McpServerFormState {
  // http 变体的 type 是必填字面量,用它做判别;stdio 的 type 在输入侧可缺省.
  if (config.type === 'http') {
    return {
      name,
      transport: 'http',
      authType,
      command: '',
      args: [],
      url: config.url,
      env: [],
      headers: mcpRecordToPairs(config.headers),
      envPassthrough: '',
      cwd: '',
      toolTimeoutSec: config.toolTimeoutSec?.toString() ?? '',
    };
  }

  return {
    name,
    transport: 'stdio',
    authType: 'none',
    command: config.command,
    args: [...(config.args ?? [])],
    url: '',
    env: mcpRecordToPairs(config.env),
    headers: [],
    envPassthrough: config.envPassthrough?.join(', ') ?? '',
    cwd: config.cwd ?? '',
    toolTimeoutSec: config.toolTimeoutSec?.toString() ?? '',
  };
}


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
                         border-2 border-solid border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-stagger-in ema-card-decorate ema-card-decorate--nodes hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]"
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


export function McpServerFormDialog({
  open,
  editing,
  onOpenChange,
}: {
  open: boolean;
  /** 编辑目标;null 表示新建.父级以 key 区分实例,切换时整体重挂重置表单. */
  editing: McpServerSummary | null;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [form, setForm] = useState(() =>
    editing
      ? mcpServerConfigToForm(editing.name, editing.config, editing.authType)
      : createEmptyMcpFormState());
  const [probeResult, setProbeResult] = useState<McpProbeResult | null>(null);
  const [probing,   setProbing]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const trimmedName = form.name.trim();
  const nameInvalid = !editing && trimmedName.length > 0 && !MCP_SERVER_NAME_RE.test(trimmedName);
  const nameValid = editing ? trimmedName.length > 0 : MCP_SERVER_NAME_RE.test(trimmedName);
  const timeout = Number(form.toolTimeoutSec);
  const timeoutValid = !form.toolTimeoutSec || (Number.isInteger(timeout) && timeout >= 5 && timeout <= 600);
  const formValid = Boolean(nameValid
    && (form.transport === 'stdio' ? form.command.trim() : form.url.trim())
    && timeoutValid);
  const hasExplicitAuthHeader = form.transport === 'http'
    && form.authType === 'oauth'
    && form.headers.some((pair) => pair.key.trim().toLowerCase() === 'authorization');

  function closeForm(): void {
    onOpenChange(false);
  }

  async function handleProbe(): Promise<void> {
    setProbing(true);
    setProbeResult(null);
    try {
      const serverName = MCP_SERVER_NAME_RE.test(trimmedName) ? trimmedName : 'probe';
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

  async function handleSave(): Promise<void> {
    if (!nameValid) {
      setSaveError(editing ? '名称不能为空' : '名称只能包含字母, 数字, 连字符 (-) 和下划线 (_)');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const config = buildMcpServerConfig(form);
      const authType: McpAuthType = form.transport === 'http' ? form.authType : 'none';
      if (editing) {
        await useMcpStore.getState().update(editing.name, config, editing.provenance, authType);
        showToast(`已更新 ${editing.name}`, { variant: 'success' });
      } else {
        await useMcpStore.getState().create(trimmedName, config, undefined, authType);
        showToast(`已保存 ${trimmedName}`, { variant: 'success' });
      }
      closeForm();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) closeForm(); }}
      title={editing ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
      description="保存配置后不会自动连接或发起鉴权, 可在列表中手动连接, 或点击进行授权"
      widthClass="max-w-lg"
    >
      {saveError && <Callout variant="danger" className="mb-3">{saveError}</Callout>}

      <div className="flex flex-col gap-3">
        <Field
          label="服务器名称"
          required
          description={editing ? '编辑模式下服务器名称不可修改' : '仅支持字母, 数字, 连字符 (-) 和下划线 (_)'}
          error={nameInvalid ? '只能包含字母, 数字, 连字符 (-) 和下划线 (_), 长度 1-100' : undefined}
        >
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
            onChange={(v) => {
              const next = v as McpTransportType;
              setForm({
                ...form,
                transport: next,
                authType: next === 'stdio' ? 'none' : form.authType,
              });
            }}
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
            <Field label="参数" description="每一项都会作为独立 argv 参数传给进程, 不进行 Shell 解析">
              <McpArgumentEditor
                value={form.args}
                onChange={(args) => setForm({ ...form, args })}
              />
            </Field>
            <Field label="环境变量" description="API Key 等, 如 AMAP_MAPS_API_KEY">
              <KeyValueEditor
                pairs={form.env}
                onChange={(env) => setForm({ ...form, env })}
                keyPlaceholder="AMAP_MAPS_API_KEY"
                valuePlaceholder="api_key"
                secret
              />
            </Field>
            <Field label="透传环境变量" description="从 Ema Server 进程按名称读取, 逗号分隔">
              <Input value={form.envPassthrough} onChange={(e) => setForm({ ...form, envPassthrough: e.target.value })} placeholder="GITHUB_TOKEN, PATH" />
            </Field>
            <Field label="工作目录">
              <Input value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} placeholder="your workspace" />
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
            <Field label="鉴权方式" description="选择 OAuth 时, 请在保存后点击服务器卡片上的「进行授权」完成登录">
              <Select
                value={form.authType}
                onChange={(v) => setForm({ ...form, authType: v as McpAuthType })}
                options={AUTH_TYPE_OPTIONS}
              />
            </Field>
            <Field label="请求头 Headers" description="鉴权等, 如 Authorization: Bearer ">
              <KeyValueEditor
                pairs={form.headers}
                onChange={(headers) => setForm({ ...form, headers })}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer sk-..."
                secret
              />
            </Field>
            {hasExplicitAuthHeader && (
              <Callout variant="warn">
                OAuth 模式下如同时保留静态 Authorization 请求头, 连接时静态请求头会优先生效并覆盖 OAuth Bearer Token
              </Callout>
            )}
          </>
        )}

        <Field label="Tool 调用超时" description="可选, 单位为秒, 范围 5 - 600">
          <Input type="number" value={form.toolTimeoutSec} onChange={(e) => setForm({ ...form, toolTimeoutSec: e.target.value })} placeholder="120" />
        </Field>

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
          <Button variant="ghost" size="sm" onClick={closeForm}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!formValid || saving}
            onClick={() => void handleSave()}
          >保存</Button>
        </div>
      </div>
    </Dialog>
  );
}
