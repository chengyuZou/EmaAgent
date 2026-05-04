import { describe, expect, it } from "vitest"

import { createWorkspaceScope, resolveWorkspacePath } from "./scope.js"

describe("workspace scope", () => {
  it("允许工作区内路径，拒绝工作区外路径", () => {
    const scope = createWorkspaceScope({
      rootDir: process.cwd(),
    })

    expect(resolveWorkspacePath(scope, ".")).toBe(process.cwd())
    expect(() => resolveWorkspacePath(scope, "..")).toThrow("路径不在工作区内")
  })
})
