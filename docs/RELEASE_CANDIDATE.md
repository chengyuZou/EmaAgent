# EmaAgent V1 Release Candidate Checklist

## Contract Lock

- Turn API: `POST /api/turns`, `GET /api/turns/:requestId/events`
- Provider API: `/api/providers`, `/api/models`, `/api/models/bindings`
- Workspace API: `/api/artifacts`, `/api/artifacts/:artifactId/apply`
- Attachment API: `/api/attachments`, `/api/sessions/:sessionId/attachments/recall`
- Memory API: `/api/memory/facts`, `/api/sessions/:sessionId/context-radar`
- Narrative API: `/api/narrative/health`, `/api/narrative/query`
- EBD API: `/api/ebd/health`, `/api/ebd/embed`, `/api/ebd/rerank`
- Telemetry API: `/api/telemetry/events`

## Local Verification

```powershell
node .\node_modules\typescript\bin\tsc -p apps\api\tsconfig.json --noEmit
node .\node_modules\typescript\bin\tsc -p apps\web\tsconfig.json --noEmit
node .\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
pnpm install --lockfile-only
pnpm test
```

## Smoke Scope

- 新建 session，chat 模式发送消息，确认 SSE 流式输出和消息落盘。
- agent 模式触发工具调用，确认 `permission_request` / `tool_result` 事件出现。
- narrative 模式发送消息，确认 narrative recall panel 可展示召回片段或空召回。
- Provider 设置页刷新模型、绑定 chat/agent/narrative/title。
- Workspace 打开 artifact，执行 apply/reject。
- ContextRadar 展示 summary、facts、recent messages 和 token budget。
- Telemetry inspector 展示最近 turn 事件。

## Packaging Notes

- Windows 开发期可直接运行 API sidecar。
- macOS/Linux 发布期需要把 SQLite 路径、workspace root、Python bridge 地址从 Tauri host 注入。
- Python bridge 未启动时，EBD 和 narrative 会降级，不阻塞主链路。
