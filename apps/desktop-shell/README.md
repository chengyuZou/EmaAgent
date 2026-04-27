# @ema-agent/desktop-shell

Tauri + React 桌面客户端。

## 定位

负责：
- React 前端 UI 渲染（AIRI 风格）
- 与本地 Fastify Gateway 通信
- Live2D 模型渲染与事件响应
- Tauri 壳进程管理（含 Python Sidecar 生命周期）

## 目录结构

```
src/
  main.tsx                          # React 应用入口
  app/
    layout/AppShell.tsx             # 主布局壳
  features/
    chat/                           # 聊天页与流式渲染
      ChatPage.tsx
      stream/useChatStream.ts
      metadata/StepPanel.tsx
      render/MessageRenderer.tsx
      render/CodeBlock.tsx
      render/MathBlock.tsx
      render/MermaidBlock.tsx
      render/ArtifactGallery.tsx
      render/useActTimeline.ts
    live2d/                         # Live2D 容器与桥接
      EmaLive2D.tsx
      useLive2DChannel.ts
    settings/                       # 设置页面（AIRI 风格）
      stores/*.ts
      pages/*.tsx
    attachments/                    # 附件面板
      AttachmentPanel.tsx
      useAttachmentUpload.ts
  constants/                        # 前端展示常量
```

## 当前状态

骨架阶段。`main.tsx` 入口已创建，组件待实现。

## 设计决策（待实现）

1. **通信方式**：前端通过 `fetch`/`WebSocket` 访问 `http://localhost:{port}`，避免 Tauri IPC 大对象序列化瓶颈。
2. **渲染管线**：所有消息正文按 `RenderBlock[]` 渲染，禁止直接渲染原始 markdown 字符串。
3. **ACT 事件消费**：`useActTimeline()` 订阅 `act` 事件，驱动 UI 情绪条与 Live2D 状态同步。

## 依赖

- `react`、`react-dom`
- `@ema-agent/core-types`
- `@vitejs/plugin-react`、`vite`
