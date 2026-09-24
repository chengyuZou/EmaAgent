# Narrative

`NarrativeClient` 只封装 TS Server 到 Python Bridge 的 HTTP 业务请求: `configure`, `recall`, `isReady`, `shutdown`. 它不负责发现端口. Rust 从 Python 的 `narrative.ready` 控制消息取得实际端口, 再通过 Server 的 `narrative.attach` 控制入口建立当前 Client. 前端需要展示端口时直接查询 Rust.

`narrative.startOnLaunch` 是下次桌面启动偏好, 通过现有 Settings API 存入 Profile SQL; 手动启停只影响当前进程. `narrative.queryMode` 在下一个 Turn 生效. 新 Turn 在工具装配时读取当时的 Client; 已运行的 Turn 保留自己的 Client 引用.
