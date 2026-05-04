import { describe, expect, it } from "vitest"

import { asId } from "@ema-agent/core-types"
import type { SessionId } from "@ema-agent/core-types"
import { createSqliteStorage } from "@ema-agent/storage-sql"

import { buildApiServer } from "./server.js"

describe("API contract smoke", () => {
  it("暴露 health、context radar、provider、bridge、telemetry 主路由", async () => {
    const storage = createSqliteStorage(":memory:")
    await storage.sessions.create({
      id: asId<SessionId>("ses_contract"),
      title: "contract",
      lastMode: "chat",
    })
    const app = await buildApiServer({ storage, logger: false })

    const health = await app.inject({ method: "GET", url: "/api/health" })
    const providers = await app.inject({ method: "GET", url: "/api/providers" })
    const radar = await app.inject({ method: "GET", url: "/api/sessions/ses_contract/context-radar?q=test&mode=chat" })
    const ebd = await app.inject({ method: "GET", url: "/api/ebd/health" })
    const narrative = await app.inject({ method: "GET", url: "/api/narrative/health" })
    const telemetry = await app.inject({ method: "GET", url: "/api/telemetry/events" })

    expect(health.statusCode).toBe(200)
    expect(providers.statusCode).toBe(200)
    expect(radar.statusCode).toBe(200)
    expect(ebd.statusCode).toBe(200)
    expect(narrative.statusCode).toBe(200)
    expect(telemetry.statusCode).toBe(200)

    await app.close()
    storage.close()
  })
})
