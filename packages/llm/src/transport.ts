import { EmaError } from "@ema-agent/core-types"

import type { FetchLike } from "./types.js"

export interface JsonResponse<T> {
  status: number
  data: T
}

/**
 * 解析 fetch 实现。
 *
 * Node 20+、浏览器、Tauri WebView 都有全局 fetch；测试时也可以显式传入 mock fetch。
 */
export function resolveFetch(fetchLike?: FetchLike): FetchLike {
  if (fetchLike) {
    return fetchLike
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis)
  }

  throw new EmaError("provider_unavailable", "当前运行环境没有可用的 fetch。", false)
}

export function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  const normalizedBase = baseUrl.replace(/\/+$/, "")
  const normalizedPath = path.replace(/^\/+/, "")
  return `${normalizedBase}/${normalizedPath}`
}

export function bearerHeaders(apiKey?: string, headers?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...headers,
  }
}

export async function requestJson<T>(
  fetchLike: FetchLike,
  url: string,
  init: RequestInit,
): Promise<JsonResponse<T>> {
  const response = await fetchLike(url, init)
  const text = await response.text()
  const data = parseJsonBody<T>(text, url)

  if (!response.ok) {
    throwHttpError(response, text, data)
  }

  return {
    status: response.status,
    data,
  }
}

export async function* streamSseJson<T>(response: Response): AsyncIterable<T> {
  if (!response.ok) {
    const text = await response.text()
    throwHttpError(response, text, text)
  }

  if (!response.body) {
    throw new EmaError("provider_unavailable", "Provider stream response body is empty.", true)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      const eventTexts = buffer.split(/\r?\n\r?\n/)
      buffer = eventTexts.pop() ?? ""

      for (const eventText of eventTexts) {
        const data = parseSseData(eventText)
        if (!data) {
          continue
        }
        if (data === "[DONE]") {
          return
        }

        yield parseSseJson<T>(data)
      }
    }

    buffer += decoder.decode()
    const data = parseSseData(buffer)
    if (data && data !== "[DONE]") {
      yield parseSseJson<T>(data)
    }
  } finally {
    reader.releaseLock()
  }
}

function parseJsonBody<T>(text: string, url: string): T {
  if (text.trim() === "") {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new EmaError("provider_unavailable", `Provider returned invalid JSON: ${url}`, true, {
      raw: text.slice(0, 300),
    })
  }
}

function parseSseJson<T>(data: string): T {
  try {
    return JSON.parse(data) as T
  } catch {
    throw new EmaError("provider_unavailable", "Provider returned invalid SSE JSON.", true, {
      raw: data.slice(0, 300),
    })
  }
}

function parseSseData(eventText: string): string | undefined {
  const data = eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")

  return data.trim() === "" ? undefined : data
}

function throwHttpError(response: Response, text: string, body: unknown): never {
  throw new EmaError(
    mapHttpStatusToErrorCode(response.status),
    `Provider request failed: HTTP ${response.status}`,
    isRetryableStatus(response.status),
    {
      status: response.status,
      statusText: response.statusText,
      body,
      raw: text.slice(0, 500),
    },
  )
}

function mapHttpStatusToErrorCode(status: number) {
  if (status === 400) return "bad_request"
  if (status === 404) return "model_not_found"
  if (status === 429) return "rate_limited"
  if (status === 408 || status >= 500) return "provider_unavailable"
  return "provider_unavailable"
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}
