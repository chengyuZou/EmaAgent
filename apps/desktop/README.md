# Desktop

Tauri 桌面宿主负责窗口、随包 Server 进程和本地资源. 前端通过 HTTP 与 Server 通信.

## 开发

在仓库根目录运行 `pnpm install --frozen-lockfile`, 然后运行 `pnpm dev:start`.

## 生成安装包

使用 `release-config.json` 指定的 Node 版本、仓库指定的 pnpm 版本及当前平台的 Rust/Tauri 构建环境. 安装依赖后, 在仓库根目录运行:

```sh
pnpm release
```

默认生成 Windows NSIS 安装程序、macOS DMG 或 Linux DEB. Windows 输出在 `apps/desktop/src-tauri/target/release/bundle/nsis/`.

```sh
pnpm release --bundles msi
pnpm release --cubism-core /path/to/live2dcubismcore.min.js
pnpm release --server-only
```

`--cubism-core` 或 `EMA_CUBISM_CORE_PATH` 指定已获得使用许可的 Cubism Core. 未指定时使用 `public/cubism/` 中已有文件; SHA-256 必须符合 `release-config.json`. 不自动下载该许可资源.

`--server-only` 仍构建当前 Server、安装生产依赖并执行独立启动检查, 但不检查 Cubism Core、不生成桌面安装包. CI 未提供许可资源时使用此模式.

`--target` 只能指定当前 Rust host, 因为 Node、SQLite、Sharp、FFmpeg 等包含平台相关文件. 指定后产物在 `src-tauri/target/<target>/release/bundle/`. 不支持在 Windows 上交叉生成 macOS 安装包.

## 发布流程

1. 检查 Node、版本号、角色资源和桌面资源.
2. 构建 Server 及其工作区依赖, 不使用遗留 `dist` 代替当前源码构建.
3. 把包清单、构建产物、锁文件和依赖补丁复制到独立临时工作区. pnpm 在其中以 hoisted 布局安装生产依赖, 不修改开发仓库的依赖目录和锁文件.
4. 生成普通文件组成的 `server/app`. 工作区包放入 `node_modules/@ema-agent`, 外部依赖的嵌套版本保留. 不把 pnpm 的链接、开发命令入口或虚拟存储目录交给安装包.
5. 删除临时安装工作区, 用随包 Node 启动发布 Server. 使用全新临时用户目录检查角色、会话、Memory 路径、HTTP 认证、SQLite 剧情初始化、Sharp 和 FFmpeg. 不读取开发用户的数据.
6. 把验证通过的文件放入 `src-tauri/.release-staging/server/app`, Node 放入 `src-tauri/binaries/ema-server-<target>`. Tauri 将这批生成文件映射到安装目录的 `server/`, 然后构建前端、Rust 宿主和安装包. `resources/` 只提供角色、模型等随代码维护的资源.

这些生成目录可以重新生成, 不应手工修改. Windows 会在打包前检查过长路径, 避免等到 NSIS/WiX 才报无法打开文件. 不要求安装软件的用户拥有 Node、pnpm、源码仓库或创建符号链接的权限.

Server 首次启动允许等待 120 秒; 超时只表示本次检查未等到就绪, 不证明启动性能正常. 打包工具下载超时、签名证书和本机系统依赖仍可能阻止生成安装包, 脚本不会把这些失败改成成功.

安装包生成不等于桌面验收完成. 发布前仍需在真实安装目录检查启动、退出、Live2D、声音及升级后的用户数据行为. 脚本不会自动安装软件.

发布脚本测试: `pnpm --filter @ema-agent/desktop test:scripts`.
