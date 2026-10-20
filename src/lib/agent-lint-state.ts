/**
 * Tailored LLM Wiki — which pages still need an agent health check.
 *
 * Agent ingest records the pages it touched; the post-batch agent lint
 * consumes that list. Persisted under .llm-wiki/ so an app restart between
 * ingest and lint does not lose the scope.
 */
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"

export interface AgentLintState {
  version: 1
  pendingPages: string[]
  lastFullLintAt: number | null
  lastLintAt: number | null
}

const EMPTY_STATE: AgentLintState = { version: 1, pendingPages: [], lastFullLintAt: null, lastLintAt: null }

function statePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/agent-lint-state.json`
}

export async function loadAgentLintState(projectPath: string): Promise<AgentLintState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(projectPath))) as Partial<AgentLintState>
    return {
      version: 1,
      pendingPages: Array.isArray(parsed.pendingPages) ? parsed.pendingPages.filter((p) => typeof p === "string") : [],
      lastFullLintAt: typeof parsed.lastFullLintAt === "number" ? parsed.lastFullLintAt : null,
      lastLintAt: typeof parsed.lastLintAt === "number" ? parsed.lastLintAt : null,
    }
  } catch {
    return { ...EMPTY_STATE, pendingPages: [] }
  }
}

async function saveAgentLintState(projectPath: string, state: AgentLintState): Promise<void> {
  await createDirectory(`${normalizePath(projectPath)}/.llm-wiki`)
  await writeFile(statePath(projectPath), JSON.stringify(state, null, 2))
}

export function isLintablePage(path: string): boolean {
  const p = normalizePath(path)
  return p.startsWith("wiki/") && p.endsWith(".md") &&
    !["wiki/index.md", "wiki/log.md", "wiki/overview.md"].includes(p)
}

export async function markPagesForAgentLint(projectPath: string, pages: string[]): Promise<void> {
  const additions = pages.map(normalizePath).filter(isLintablePage)
  if (additions.length === 0) return
  await withProjectLock(`${normalizePath(projectPath)}\0agent-lint-state`, async () => {
    const state = await loadAgentLintState(projectPath)
    state.pendingPages = Array.from(new Set([...state.pendingPages, ...additions])).sort()
    await saveAgentLintState(projectPath, state)
  })
}

export async function completeAgentLint(
  projectPath: string,
  checkedPages: string[] | "all",
  at = Date.now(),
): Promise<void> {
  await withProjectLock(`${normalizePath(projectPath)}\0agent-lint-state`, async () => {
    const state = await loadAgentLintState(projectPath)
    if (checkedPages === "all") {
      state.pendingPages = []
      state.lastFullLintAt = at
    } else {
      const done = new Set(checkedPages.map(normalizePath))
      state.pendingPages = state.pendingPages.filter((p) => !done.has(p))
    }
    state.lastLintAt = at
    await saveAgentLintState(projectPath, state)
  })
}

export function fullLintDue(state: AgentLintState, everyDays: number, now = Date.now()): boolean {
  if (everyDays <= 0) return false
  // The first automatic full pass waits one interval after the baseline is
  // recorded; an existing large wiki must not trigger a full run on the very
  // first ingest batch. Users can always start one manually.
  if (state.lastFullLintAt === null) return false
  return now - state.lastFullLintAt >= everyDays * 24 * 60 * 60 * 1000
}

/** Record "now" as the full-lint baseline the first time agent lint runs. */
export async function ensureFullLintBaseline(projectPath: string, at = Date.now()): Promise<void> {
  await withProjectLock(`${normalizePath(projectPath)}\0agent-lint-state`, async () => {
    const state = await loadAgentLintState(projectPath)
    if (state.lastFullLintAt !== null) return
    state.lastFullLintAt = at
    await saveAgentLintState(projectPath, state)
  })
}
