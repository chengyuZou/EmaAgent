import type { ArtifactDetail, ArtifactSummary } from "@ema-agent/core-types"

import type { createArtifactApiClient } from "../api/artifacts.js"

type ArtifactApiClient = ReturnType<typeof createArtifactApiClient>

export interface EditorDocumentState {
  artifactId: string
  language?: string
  title: string
  content: string
  targetPaths: string[]
}

export interface DiffEditorState {
  artifactId: string
  title: string
  original: string
  modified: string
  language?: string
  targetPath?: string
}

export interface WorkspacePaneState {
  loading: boolean
  applying: boolean
  sessionId?: string
  artifacts: ArtifactSummary[]
  selectedArtifact?: ArtifactDetail
  editor?: EditorDocumentState
  diff?: DiffEditorState
  error?: string
}

export interface WorkspacePaneController {
  getState(): WorkspacePaneState
  subscribe(listener: (state: WorkspacePaneState) => void): () => void
  loadSession(sessionId: string): Promise<void>
  openArtifact(artifactId: string): Promise<void>
  applySelected(expectedSha256ByPath?: Record<string, string>): Promise<void>
  rejectSelected(): Promise<void>
  closeArtifact(): void
}

/**
 * WorkspacePane 的无框架状态控制器。
 *
 * React 页面后续可以把 editor 映射到 Monaco Editor，
 * 把 diff 映射到 Monaco DiffEditor，不需要在这里直接依赖 Monaco 包。
 */
export function createWorkspacePaneController(client: ArtifactApiClient): WorkspacePaneController {
  let state: WorkspacePaneState = {
    loading: false,
    applying: false,
    artifacts: [],
  }
  const listeners = new Set<(state: WorkspacePaneState) => void>()

  const setState = (patch: Partial<WorkspacePaneState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state)
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },

    async loadSession(sessionId) {
      await run(setState, async () => {
        const page = await client.listBySession(sessionId)
        setState({
          sessionId,
          artifacts: page.items,
        })
      })
    },

    async openArtifact(artifactId) {
      await run(setState, async () => {
        const artifact = await client.getArtifact(artifactId)
        setState({
          selectedArtifact: artifact,
          editor: toEditorState(artifact),
          diff: toDiffState(artifact),
        })
      })
    },

    async applySelected(expectedSha256ByPath = {}) {
      const artifactId = state.selectedArtifact?.summary.id
      if (!artifactId) {
        return
      }

      setState({ applying: true, error: undefined })
      try {
        await client.applyArtifact(artifactId, expectedSha256ByPath)
        if (state.sessionId) {
          const page = await client.listBySession(state.sessionId)
          setState({ artifacts: page.items })
        }
      } catch (error) {
        setState({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        setState({ applying: false })
      }
    },

    async rejectSelected() {
      const artifactId = state.selectedArtifact?.summary.id
      if (!artifactId) {
        return
      }

      setState({ applying: true, error: undefined })
      try {
        await client.rejectArtifact(artifactId)
        if (state.sessionId) {
          const page = await client.listBySession(state.sessionId)
          setState({ artifacts: page.items })
        }
      } catch (error) {
        setState({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        setState({ applying: false })
      }
    },

    closeArtifact() {
      setState({
        selectedArtifact: undefined,
        editor: undefined,
        diff: undefined,
      })
    },
  }
}

function toEditorState(artifact: ArtifactDetail): EditorDocumentState | undefined {
  if (artifact.summary.kind === "patch") {
    return undefined
  }

  return {
    artifactId: artifact.summary.id,
    title: artifact.summary.title,
    language: artifact.summary.params?.language,
    content: artifact.payload.type === "inline" ? artifact.payload.content : "",
    targetPaths: artifact.summary.targetPaths ?? [],
  }
}

function toDiffState(artifact: ArtifactDetail): DiffEditorState | undefined {
  const diff = artifact.summary.params?.diff
  if (!diff || artifact.payload.type !== "inline") {
    return undefined
  }

  return {
    artifactId: artifact.summary.id,
    title: artifact.summary.title,
    original: "",
    modified: artifact.payload.content,
    language: artifact.summary.params?.language,
    targetPath: diff.files[0]?.path,
  }
}

async function run(setState: (patch: Partial<WorkspacePaneState>) => void, fn: () => Promise<void>): Promise<void> {
  setState({ loading: true, error: undefined })
  try {
    await fn()
  } catch (error) {
    setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    setState({ loading: false })
  }
}
