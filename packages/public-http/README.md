# @ema-agent/public-http

公网出口唯一通道。所有"程序代替用户去公网抓东西"的功能**必须**走 `fetchPublicResource`,禁止直接 `fetch()`。核心职责: **SSRF 防护**。

消费者: `web_fetch` 工具(`fetchPublicPage`)、`marketplace` 包(`fetchWithMirror`)。

## 6 道关

`fetchPublicResource(url, options)` 内顺序执行:

```
[1] parsePublicHttpUrl       URL 静态白名单: 只 http/https,拒 user:pass / 单标签主机 / localhost / .local,≤ 2048 字符
[2] approvePublicTarget      dns.lookup 全解析结果必须落公网段,任一落私网即整体拒;记首解析 IP
[3] isPublicNetworkAddress   IPv4/IPv6 段黑名单(IPv4-mapped-IPv6 与 6to4 穿透校验,防 IPv6 包皮绕过)
[4] requestPinned            lookup 回调钉死审批 IP,防 DNS rebinding(审批后二次解析到内网)
[5] assertSafePublicRedirect 3xx 必须同主机(去 www 比),只允许 http->https 升级,每跳重走 1~4,最多 5 跳
[6] readBoundedResponseBody  Content-Length 预检 + 流式字节累计,超 maxBytes 立即 destroy()
```

取消: `AbortSignal.timeout(15s)` 与外部 signal 经 `AbortSignal.any` 合并,贯穿全程(DNS 无 signal 参数,`waitForSignal` 竞速兜底)。

## Facade

| Facade | 职责 |
|---|---|
| `fetchPublicResource` | 主 Facade,执行 6 道关 |
| `approvePublicTarget` | 关 1~3,返回固定 IP |
| `assertSafePublicRedirect` | 关 5 |
| `isObviouslyUnsafePublicUrl` | 静态预检(关 1+3,无 DNS),权限层提前 deny 用,**非完整防护替代** |
| `isPublicNetworkAddress` | IP 段校验(关 3) |

`PublicHttpRequestOptions.maxBytes` **必填**(防超大响应耗尽内存,不设默认值)。`requestPinned` 硬编码 `method:'GET'`;`Accept-Encoding: identity` 禁 gzip(防压缩炸弹)。

## 文件

| 文件 | 层 | 职责 |
|---|---|---|
| `url-policy.ts` | 策略层(安全核心) | URL 解析 + DNS 审批 + IP 段校验 + 重定向校验;纯逻辑,唯一 IO 是 DNS |
| `client.ts` | 传输层 | 固定 IP 请求 + 重定向跟随 + 体积限制 + 超时取消;纯 IO,无策略 |
| `types.ts` / `errors.ts` | 契约 | `PublicHttpPolicyError`(关 1/2/3/5) / `PublicHttpLimitError`(关 5/6) / `PublicHttpStatusError`(非 2xx) |

两层分工: url-policy 判"能不能去",client "怎么去"。

## 不走 public-http 的合法场景

全项目多处原生 `fetch` 不是漏洞:

| 场景 | 为什么不走 |
|---|---|
| 本地 sidecar/bridge(`127.0.0.1`) | public-http 拒本机地址 |
| 前端 BFF 同源请求 | Node 包不适用(`desktop-ui/api/sidecar-client.ts` 唯一出口) |
| 云 API adapter(llm/ebd/tts/stt/vision) | baseUrl 来自用户 provider 配置,非外部可控,用户自负;且本包不支持 POST body/流式/鉴权头透传 |
| `web_search`(`BoundedFetch`) | 目标主机硬编码(brave/bing/duckduckgo),query 仅当参数,无法改主机 |
| Live2D 资源 / 脚本 / 手测 | 本地路径或非生产代码 |

红线: URL 不可控(LLM/用户/外部元数据)**必须**用 `fetchPublicResource`;硬编码可信端点可用 `BoundedFetch`。不用第三方库(npm SSRF 库只判 IP 段,不管 URL/重定向/DNS,本包难点无库覆盖)、不用独立代理(单机本地应用,违背轻量定位)。

## 不做

- 不做请求构造(只 GET,不透传 method/body/init;需 POST/鉴权头的固定可信 API 用 `BoundedFetch`)
- 不做云 API 适配(baseUrl 来自用户 provider 配置,非本包职责)
- 不做 DoH/DoT(本地应用,系统 DNS 可信)
