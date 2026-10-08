# Read

Read 按文件格式返回文本、图片、Notebook 或 PDF. 附件只提供本地 path, Agent 用同一个 Read 入口读取内容; 文本定位仍由 Grep 执行.

文本使用从 1 起的行号参数 `offset` 和 `limit`. PDF 使用从 1 起的页码参数 `start_page` 和 `page_count`, 两组参数不能混用; PDF 默认读取 10 页, 单次最多 20 页, 文件最多 50 MiB.

PDF 文本层可用时直接解析正文; 扫描页或乱码页经本 Turn 的 Vision 绑定做 OCR, 含显著位图的页追加图表描述. 没有绑定或视觉读取失败时保留可读正文并返回页级 warnings. 纯矢量图表目前不触发图注. 总页数和 nextPage 用于继续读取, 正文不跨页合并, 避免定位信息错误.

PDF 解析依赖在第一次 PDF 读取时加载. 扫描页渲染使用可选原生 canvas 依赖, 缺失时明确报告 OCR 不完整. 原始 PDF 是二进制, 提取正文不写入 FileStateCache, 不能作为 Edit 的文本编辑基准.

前端 Read 结果卡按相同结果类型显示页范围、续读位置、warnings 和正文预览. PDF 的内容提取不等于页面视觉验证.

验证入口:

- `tests/fileReadPdf.test.ts`: 参数、体积与签名、模型投影和编辑缓存隔离.
- `tests/pdfParsing.test.ts`: 文本/OCR/图注分支与乱码检测.
- `tests/fileReadPdfParsing.test.ts`: 真实 pdfjs 解析、分页归属和取消.
- `tests/fileReadPdfView.test.tsx`: 页码、缺失内容警告和续读位置的结果卡展示.
