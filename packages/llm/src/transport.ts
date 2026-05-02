import type { FetchLike } from "./types.js"

export interface JsonResponse<T> {
  status: number
  data: T
}

/**
 * HTTP 传输骨架。
 *
 * 这里后面再决定是直接 fetch、官方 SDK，还是加重试/超时/trace 包装。
 */
export function resolveFetch(fetchLike?: FetchLike): FetchLike | undefined {
  return fetchLike
}

export function joinUrl(baseUrl: string, path: string): string {
  void baseUrl
  return path
}

export function bearerHeaders(apiKey?: string, headers?: Record<string, string>): Record<string, string> {
  void apiKey
  return headers ?? {}
}

export async function requestJson<T>(
  fetchLike: FetchLike,
  url: string,
  init: RequestInit,
): Promise<JsonResponse<T>> {
  void fetchLike
  void url
  void init
  return {
    status: 0,
    data: {} as T,
  }
}

export async function* streamSseJson<T>(response: Response): AsyncIterable<T> {
  void response
}
