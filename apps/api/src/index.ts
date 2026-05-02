import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { createSqliteStorage } from "@ema-agent/storage-sql"

import { buildApiServer } from "./server.js"

const port = Number(process.env.EMA_API_PORT ?? 3421)
const host = process.env.EMA_API_HOST ?? "127.0.0.1"
const dbPath = process.env.EMA_DB_PATH ?? join(process.cwd(), "data", "ema.sqlite")

if (dbPath !== ":memory:") {
  mkdirSync(dirname(dbPath), { recursive: true })
}

const storage = createSqliteStorage(dbPath)
const app = await buildApiServer({ storage })

const close = async () => {
  await app.close()
  storage.close()
}

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0))
})

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0))
})

await app.listen({ host, port })
