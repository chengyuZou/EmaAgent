# EmaAgent Frontend

基于 React + TypeScript + Vite 的前端界面。

## 1. 安装与启动

```bash
cd frontend
npm install
npm run dev
```

默认地址：`http://localhost:5173`

## 2. 常用命令

```bash
# 开发模式
npm run dev

# 生产构建
npm run build

# 本地预览构建产物
npm run preview
```

## 3. 目录说明

```text
frontend/
├─ src/
│  ├─ components/      # 页面与组件
│  ├─ styles/          # 额外样式文件
│  ├─ App.tsx          # 应用入口组件
│  ├─ main.tsx         # React 挂载入口
│  └─ index.css        # 全局样式
├─ public/             # 静态资源（Live2D、测试页等）
├─ package.json
├─ vite.config.ts
└─ README.md
```

## 4. Vite 代理说明

开发模式下会代理到后端 `http://localhost:8000`：

- `/api`
- `/audio`
- `/live2d`
- `/static`

以及 WebSocket：

- `/api/ws/chat`
- `/api/live2d/ws`

## 5. node_modules 是什么

`node_modules/` 是 `npm install` 后自动下载的依赖目录。

- 来源：`package.json` + `package-lock.json`
- 作用：存放前端运行和构建所需库（React、Vite、Tailwind 等）
- 是否手动维护：不需要
- 是否提交到 Git：不建议（通常由 `.gitignore` 忽略）

如果要重装依赖，可以删除 `node_modules` 后重新执行：

```bash
npm install
```

## 6. 技术栈

- React 19
- TypeScript
- Vite 5
- TailwindCSS
- Framer Motion
- Lucide React
