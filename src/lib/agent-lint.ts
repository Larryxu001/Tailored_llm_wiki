/**
 * Tailored LLM Wiki — agent lint (self-correcting health check).
 *
 * The stock semantic lint sends only the first 500 characters of every page
 * in one prompt and can only report findings. Agent lint lets Codex / Claude
 * Code read full pages, fix mechanical problems directly (broken links,
 * orphans, duplicate pages, missing frontmatter, stale statements that the
 * wiki's own sources already correct), log every change, and hand only real
 * judgment calls to the Review queue.
 *
 * Scope:
 *   - "pending": pages touched by agent ingest since the last lint, plus
 *     their direct neighbours (the agent follows links itself).
 *   - "full":    the whole wiki, processed folder by folder.
 */
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { withProjectLock } from "@/lib/project-mutex"
import { getLanguagePromptName } from "@/lib/language-metadata"
import { getOutputLanguage } from "@/lib/output-language"
import { agentLlmConfig, agentRequestOverrides, supportsAgentMode, useAgentConfigStore } from "@/lib/agent-config"
import { diffSnapshots, snapshotWiki } from "@/lib/agent-ingest"
import {
  completeAgentLint,
  ensureFullLintBaseline,
  fullLintDue,
  isLintablePage,
  loadAgentLintState,
} from "@/lib/agent-lint-state"

export type AgentLintScope = { kind: "pending"; pages: string[] } | { kind: "full" }

export interface AgentLintResult {
  changedPages: string[]
  deletedPages: string[]
  reviewItems: number
  skipped?: string
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

/** Same block format as ingest; kept local so ingest.ts stays untouched. */
export function parseAgentReviewBlocks(
  text: string,
  sourcePath?: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  for (const match of text.matchAll(REVIEW_BLOCK_REGEX)) {
    const rawType = match[1].trim().toLowerCase()
    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion", "confirm"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]
    const body = match[3].trim()
    const optionsLine = body.match(/^OPTIONS:\s*(.+)$/m)
    const pagesLine = body.match(/^PAGES:\s*(.+)$/m)
    const options = optionsLine
      ? optionsLine[1].split("|").map((o) => o.trim()).filter(Boolean).map((label) => ({ label, action: label }))
      : [{ label: "Approve", action: "Approve" }, { label: "Skip", action: "Skip" }]
    items.push({
      type,
      title: match[2].trim(),
      description: body.replace(/^OPTIONS:.*$/m, "").replace(/^PAGES:.*$/m, "").replace(/^SEARCH:.*$/m, "").trim(),
      sourcePath,
      affectedPages: pagesLine ? pagesLine[1].split(",").map((p) => p.trim()).filter(Boolean) : undefined,
      options,
    })
  }
  return items
}

export function buildAgentLintPrompt(scope: AgentLintScope, outputLanguage: string, today: string): string {
  const scopeLines = scope.kind === "full"
    ? [
        "Scope: the WHOLE wiki. Work folder by folder under wiki/ so you never need every page in context at once.",
      ]
    : [
        "Scope: these recently changed pages, plus the pages they link to and the pages that link to them:",
        ...scope.pages.slice(0, 200).map((p) => `- ${p}`),
      ]
  return [
    "You are the maintenance agent of this LLM Wiki project. Your working directory is the project root.",
    "Run one health check and fix what you can in this single run. Work autonomously; never ask questions.",
    "",
    "Read purpose.md and schema.md first (and any rule file they reference); they define what a correct page looks like.",
    ...scopeLines,
    "",
    "## Fix directly (read the full page before editing)",
    "- Broken [[wikilinks]]: point them at the existing page that was meant, or remove the link.",
    "- Orphan pages: add links from the most relevant pages.",
    "- Duplicate pages for the same entity/concept (aliases, tickers, translations): merge into one page, keep every source's contribution, update links, delete the duplicate.",
    "- Missing or invalid frontmatter fields required by schema.md.",
    "- Stale or superseded statements: when another page or a later-dated source in the wiki already gives the newer fact (e.g. a forecast whose actual value is now reported), rewrite the statement to the current understanding and keep the old one in the page's change-log section with date, reason and source.",
    "- Pages that only restate a source summary: rewrite into a synthesis of current understanding.",
    "",
    "## Do NOT fix — report instead",
    "- Genuine contradictions between sources (different institutions, same metric and period).",
    "- Facts you cannot confirm from files in this project.",
    "",
    "## Never",
    "- Modify raw/, purpose.md, schema.md, .obsidian/, .llm-wiki/, wiki/index.md, wiki/overview.md.",
    "- Delete or rename anything in wiki/sources/ or wiki/media/ (source summaries are tied to their raw files; you may edit their text).",
    "- Invent facts. Use only what pages and files in raw/ support.",
    "- Edit paragraphs marked %%人工%% (human-owned).",
    "",
    `When done, append one entry dated ${today} to wiki/log.md: "lint" plus a bullet list of every page you changed or deleted and why.`,
    "",
    "## Final message",
    "Reply with review blocks for the issues you reported (none if there are none), and always end with the line LINT-COMPLETE. Review block format:",
    "---REVIEW: contradiction|duplicate|missing-page|confirm|suggestion | Short title---",
    "What the human needs to decide, with the evidence on each side.",
    "OPTIONS: option A | option B",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "---END REVIEW---",
    "",
    `Write all prose in ${outputLanguage}.`,
  ].join("\n")
}

let runningLint: Promise<AgentLintResult> | null = null

export function isAgentLintRunning(): boolean {
  return runningLint !== null
}

export async function runAgentLint(
  projectPath: string,
  llmConfig: LlmConfig,
  scope: AgentLintScope,
  signal?: AbortSignal,
): Promise<AgentLintResult> {
  if (!supportsAgentMode(llmConfig)) {
    return { changedPages: [], deletedPages: [], reviewItems: 0, skipped: "Agent lint needs the Codex CLI or Claude Code provider." }
  }
  if (scope.kind === "pending" && scope.pages.length === 0) {
    return { changedPages: [], deletedPages: [], reviewItems: 0, skipped: "Nothing changed since the last lint." }
  }
  if (runningLint) return runningLint
  runningLint = runAgentLintImpl(projectPath, llmConfig, scope, signal).finally(() => {
    runningLint = null
  })
  return runningLint
}

async function runAgentLintImpl(
  projectPath: string,
  llmConfig: LlmConfig,
  scope: AgentLintScope,
  signal?: AbortSignal,
): Promise<AgentLintResult> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: scope.kind === "full" ? "Agent lint (full wiki)" : `Agent lint (${scope.pages.length} changed pages)`,
    status: "running",
    detail: "Starting agent health check...",
    filesWritten: [],
  })

  // The agent edits wiki pages directly, so it takes the same project commit
  // lock ingest uses; an ingest and a lint never write at the same time.
  return withProjectLock(pp, async () => {
    const agentConfig = useAgentConfigStore.getState().config
    let overviewSample = ""
    try { overviewSample = await readFile(`${pp}/purpose.md`) } catch { /* optional */ }
    const outputLanguage = getLanguagePromptName(getOutputLanguage(overviewSample))
    const prompt = buildAgentLintPrompt(scope, outputLanguage, new Date().toISOString().slice(0, 10))

    const before = await snapshotWiki(pp)
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      activity.updateItem(activityId, {
        detail: `Agent lint running (${Math.round((Date.now() - startedAt) / 1000)}s)...`,
      })
    }, 2000)
    let finalText = ""
    let agentError: Error | null = null
    try {
      await streamChat(
        agentLlmConfig(llmConfig, agentConfig),
        [{ role: "user", content: prompt }],
        {
          onToken: (token) => { finalText += token },
          onDone: () => {},
          onError: (err) => { agentError = err },
        },
        signal,
        agentRequestOverrides(agentConfig),
      )
    } finally {
      clearInterval(ticker)
    }
    if (signal?.aborted) {
      activity.updateItem(activityId, { status: "error", detail: "Agent lint cancelled" })
      throw new Error("Agent lint cancelled")
    }
    if (agentError) {
      activity.updateItem(activityId, { status: "error", detail: `Agent lint failed: ${(agentError as Error).message}` })
      throw agentError
    }

    const after = await snapshotWiki(pp)
    const { changed, deleted } = diffSnapshots(before, after)
    const changedPages = changed.filter((p) => p !== "wiki/index.md" && p !== "wiki/overview.md")

    if (deleted.length > 0) await pruneDeletedPagesFromIndex(pp, deleted)
    try {
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch {
      // ignore
    }

    const reviewItems = parseAgentReviewBlocks(finalText)
    if (reviewItems.length > 0) useReviewStore.getState().addItems(reviewItems)

    await completeAgentLint(pp, scope.kind === "full" ? "all" : scope.pages)
    await reembedPages(pp, changedPages.filter(isLintablePage))

    const secs = Math.round((Date.now() - startedAt) / 1000)
    activity.updateItem(activityId, {
      status: "done",
      detail: [
        `Agent lint: ${changedPages.filter(isLintablePage).length} page(s) fixed in ${secs}s`,
        deleted.length > 0 ? `${deleted.length} duplicate page(s) merged` : "",
        reviewItems.length > 0 ? `${reviewItems.length} item(s) sent to Review` : "no review items",
      ].filter(Boolean).join(", "),
      filesWritten: changedPages,
    })
    return { changedPages, deletedPages: deleted, reviewItems: reviewItems.length }
  })
}

/** Drop index lines that point at pages the agent merged away. */
async function pruneDeletedPagesFromIndex(projectPath: string, deleted: string[]): Promise<void> {
  const indexPath = `${projectPath}/wiki/index.md`
  let index = ""
  try { index = await readFile(indexPath) } catch { return }
  const stems = new Set(deleted.map((p) => p.split("/").pop()?.replace(/\.md$/, "") ?? "").filter(Boolean))
  const kept = index.split("\n").filter((line) => {
    const m = line.match(/\[\[([^\]|#]+)/)
    if (!m) return true
    const target = m[1].split("/").pop()?.replace(/\.md$/, "") ?? ""
    return !stems.has(target)
  })
  if (kept.length !== index.split("\n").length) await writeFile(indexPath, kept.join("\n"))
}

async function reembedPages(projectPath: string, pages: string[]): Promise<void> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model || pages.length === 0) return
  try {
    const { embedPage, wikiPageIdFromPath } = await import("@/lib/embedding")
    const { pageTitleFromContent } = await import("@/lib/agent-ingest")
    for (const page of pages) {
      const pageId = wikiPageIdFromPath(projectPath, page)
      if (!pageId) continue
      try {
        const content = await readFile(`${projectPath}/${page}`)
        await embedPage(projectPath, pageId, pageTitleFromContent(content, pageId), content, embCfg)
      } catch {
        // non-critical
      }
    }
  } catch {
    // embedding module unavailable
  }
}

/**
 * Called when the ingest queue drains: lint what this batch touched, and run
 * the periodic full lint when it is due.
 */
export async function runAgentLintAfterIngestBatch(
  projectPath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const config = useAgentConfigStore.getState().config
  if (!supportsAgentMode(llmConfig)) return
  await ensureFullLintBaseline(projectPath)
  const state = await loadAgentLintState(projectPath)
  if (fullLintDue(state, config.fullLintEveryDays)) {
    await runAgentLint(projectPath, llmConfig, { kind: "full" }, signal)
    return
  }
  if (config.lintAfterIngest && state.pendingPages.length > 0) {
    await runAgentLint(projectPath, llmConfig, { kind: "pending", pages: state.pendingPages }, signal)
  }
}
