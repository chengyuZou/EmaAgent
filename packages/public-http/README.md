# @ema-agent/public-http

公网出口唯一通道。所有"程序代替用户去公网抓东西"的功能**必须**走 `fetchPublicResource`,禁止直接 `fetch()`。核心职责: **SSRF 防护**。

当前消费者: `web_fetch` 工具(经 `tool-builtin/WebFetchTool/httpClient.ts` 的 `fetchPublicPage`)、`marketplace` 包(经 `fetchWithMirror`)。

## 6 道关

`fetchPublicResource(url, options)` 内顺序执行:

```
[1] parsePublicHttpUrl       URL 静态白名单: 只 http/https,拒 user:pass / 单标签主机 / localhost / .local,≤ 2048 字符
[2] approvePublicTarget      dns.lookup 全解析结果必须落公网段,任一落私网即整体拒;记首解析 IP
[3] isPublicNetworkAddress   IPv4/IPv6 段黑名单(IPv4-mapped-IPv6 与 6to4 穿透校验,防 IPv6 包皮绕过)
[4] requestPinned            lookup 回调钉死审批 IP,防 DNS rebinding(审批后二次解析到内网)
[5] assertSafePublicRedirect 3xx 必须同主机(去 www 比),只允许 http->https 标准升级,每跳重走 1~4,最多 5 跳
[6] readBoundedResponseBody  Content-Length 预检 + 流式字节累计,超 maxBytes 立即 destroy()
```

取消: `AbortSignal.timeout(15s)` 与外部 signal 经 `AbortSignal.any` 合并,贯穿 DNS/连接/读取全程(DNS 无 AbortSignal 参数,`waitForSignal` 竞速兜底)。

## 文件结构

| 文件 | 层 | 职责 |
|---|---|---|
| `url-policy.ts` | 策略层(安全核心) | URL 解析 + DNS 审批 + IP 段校验 + 重定向校验;纯逻辑,唯一 IO 是 DNS |
| `client.ts` | 传输层 | 固定 IP 请求 + 重定向跟随 + 体积限制 + 超时取消;纯 IO,无策略 |
| `types.ts` | 契约 | `ApprovedPublicTarget` / `PublicHttpRequestOptions`(`maxBytes` 必填) / `PublicHttpResponse`(`body: Buffer`) |
| `errors.ts` | 契约 | `PublicHttpPolicyError`(关 1/2/3/5) / `PublicHttpLimitError`(关 5/6) / `PublicHttpStatusError`(非 2xx) |

两层分工: url-policy 判"能不能去",client "怎么去"。

## API

```typescript
fetchPublicResource(rawUrl, options): Promise<PublicHttpResponse>  // 主 Facade,执行 6 道关
approvePublicTarget(rawUrl): Promise<ApprovedPublicTarget>         // 关 1~3,返回固定 IP
assertSafePublicRedirect(previous, next): void                     // 关 5
isObviouslyUnsafePublicUrl(rawUrl): boolean                        // 静态预检(关 1+3,无 DNS)
isPublicNetworkAddress(address): boolean                           // IP 段校验(关 3)
readBoundedResponseBody(response, maxBytes, signal): Promise<Buffer> // 关 6,导出仅供测试
```

`isObviouslyUnsafePublicUrl` 只做静态判断,**不做 DNS**。完整 SSRF 防护必须走 `fetchPublicResource`。它用于权限层提前 deny,不是完整防护的替代。

## 不走 public-http 的合法场景

全项目 grep `fetch(` 有多处原生 fetch,**不是漏洞**:

| 场景 | 为什么不走 |
|---|---|
| 本地 sidecar/bridge(`127.0.0.1`) | public-http 拒本机地址;sidecar-store / narrative-client 走原生 fetch |
| 前端 BFF 同源请求 | Node 包不适用;`desktop-ui/api/sidecar-client.ts` 是前端唯一出口 |
| 云 API adapter(llm/ebd/tts/stt/vision) | baseUrl 来自用户 provider 配置,非外部可控,用户自负;且本包不支持 POST body/流式/鉴权头透传 |
| `web_search`(`BoundedFetch`) | 目标主机硬编码(brave/bing/duckduckgo),query 仅当参数,无法改主机;`redirect:'error'` 不跟随 |
| Live2D 资源 / 脚本 / 手测工具 | 本地路径或非生产代码 |

红线: URL 不可控(LLM/用户/外部元数据)的场景**必须**用 `fetchPublicResource`;硬编码可信端点可用 `BoundedFetch`(务必加 JSDoc 标注"仅硬编码端点")。

## 设计取舍

- **不用第三方库**(`private-ip` 等): npm SSRF 库多为零件,只判 IP 段,不管 URL/重定向/DNS;本包难点(IP pinning 防 rebinding、每跳重审重定向、IPv4-mapped-IPv6 穿透、双体积限制)无库覆盖。340 行可审计,自维护成本低于跟踪外部 CVE
- **不用独立代理**(Smokescreen 等): 单机本地应用,起代理进程违背轻量定位,进程内方案正确
- **`maxBytes` 必填**: 防超大响应耗尽内存,不设默认值兜底,强迫调用方显式声明预算
- **`Accept-Encoding: identity`**: 禁 gzip,省解压代码 + 防压缩炸弹,代价是不省带宽(桌宠可接受)
- **只 GET**: `requestPinned` 硬编码 `method:'GET'`;云 API 需 POST body/流式,故云 adapter 不走本包

## 测试

- `tests/url-policy.test.ts`: 黑名单 URL 拒绝 + 公网地址区分 + 同站重定向校验
- `tests/client.test.ts`: `readBoundedResponseBody` 三边界(声明长度超限/实际流量超限/预算内返回),用 `PassThrough` 假流,**不发真实请求**

未覆盖: 端到端真重定向/真超时/真 DNS 路径(需 mock HTTP server,当前未做)。

## 不做

- 不做请求构造(只 GET,不透传 method/body/init;需鉴权头透传或 POST 的固定可信 API 用 `BoundedFetch`)
- 不做云 API 适配(baseUrl 来自用户配置的 provider,非本包职责)
- 不做 DoH/DoT(本地应用,系统 DNS 可信)
