/**
 * Tailored LLM Wiki — agent ingest.
 *
 * The stock pipeline treats Codex / Claude Code as a stateless text model:
 * every analysis, generation, review and merge step spawns a fresh CLI
 * process and re-sends schema + index + the whole source. One agent run
 * instead reads the source once, searches the existing wiki itself, writes
 * and merges pages in place, and reports review items in its final message.
 *
 * The app still owns everything deterministic: source identity, extraction
 * (incl. MinerU), image extraction, index/log bookkeeping, review IDs, the
 * ingest cache and embeddings.
 */
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import {
  createDirectory,
  deleteFile,
  getFileModifiedTime,
  getFileSize,
  listDirectory,
  readFile,
  writeFile,
} from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { saveIngestCache } from "@/lib/ingest-cache"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { parseFrontmatter } from "@/lib/frontmatter"
import { detectLanguage } from "@/lib/detect-language"
import { getLanguagePromptName } from "@/lib/language-metadata"
import { getOutputLanguage } from "@/lib/output-language"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import type { SavedImage } from "@/lib/extract-source-images"
import { agentLlmConfig, agentRequestOverrides, useAgentConfigStore } from "@/lib/agent-config"
import { markPagesForAgentLint } from "@/lib/agent-lint-state"

type ReviewDraft = Omit<ReviewItem, "id" | "resolved" | "createdAt">

export interface AgentIngestContext {
  projectPath: string
  /** Absolute, normalized source path. */
  sourcePath: string
  sourceIdentity: string
  sourceSummaryPath: string
  /** Text the app extracted from the source (MinerU / built-in parser). */
  sourceContent: string
  savedImages: SavedImage[]
  folderContext?: string
  llmConfig: LlmConfig
  signal?: AbortSignal
  activityId: string
  onFileWritten?: (relativePath: string) => void
}

export interface AgentIngestDeps {
  updateIndex: (projectPath: string, writtenPaths: string[]) => Promise<boolean>
  parseReviews: (text: string, sourcePath: string) => ReviewDraft[]
  buildLog: (existing: string, sourceIdentity: string) => string
  injectImages: () => Promise<void>
  embedPages: (writtenPaths: string[]) => Promise<void>
}

/** mtime+size fingerprint of every Markdown file under wiki/. */
export async function snapshotWiki(projectPath: string): Promise<Map<string, string>> {
  const pp = normalizePath(projectPath)
  const snapshot = new Map<string, string>()
  let tree: FileNode[] = []
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch {
    return snapshot
  }
  const files: FileNode[] = []
  const walk = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) walk(node.children ?? [])
      else if (node.name.endsWith(".md")) files.push(node)
    }
  }
  walk(tree)
  const SNAPSHOT_CONCURRENCY = 32
  for (let i = 0; i < files.length; i += SNAPSHOT_CONCURRENCY) {
    await Promise.all(files.slice(i, i + SNAPSHOT_CONCURRENCY).map(async (file) => {
      const abs = normalizePath(file.path)
      const rel = abs.startsWith(`${pp}/`) ? abs.slice(pp.length + 1) : abs
      try {
        const [mtime, size] = await Promise.all([getFileModifiedTime(abs), getFileSize(abs)])
        snapshot.set(rel, `${mtime}:${size}`)
      } catch {
        snapshot.set(rel, "unknown")
      }
    }))
  }
  return snapshot
}

export function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): { changed: string[]; deleted: string[] } {
  const changed: string[] = []
  const deleted: string[] = []
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) changed.push(path)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path)
  }
  return { changed: changed.sort(), deleted: deleted.sort() }
}

/** Drop index lines that point at pages an agent merged away or deleted. */
export async function pruneDeletedPagesFromIndex(projectPath: string, deleted: string[]): Promise<boolean> {
  if (deleted.length === 0) return false
  const indexPath = `${projectPath}/wiki/index.md`
  let index = ""
  try { index = await readFile(indexPath) } catch { return false }
  const stems = new Set(deleted.map((p) => p.split("/").pop()?.replace(/\.md$/, "") ?? "").filter(Boolean))
  const lines = index.split("\n")
  const kept = lines.filter((line) => {
    const m = line.match(/\[\[([^\]|#]+)/)
    if (!m) return true
    const target = m[1].split("/").pop()?.replace(/\.md$/, "") ?? ""
    return !stems.has(target)
  })
  if (kept.length === lines.length) return false
  await writeFile(indexPath, kept.join("\n"))
  return true
}

/** Local calendar date (YYYY-MM-DD); toISOString() would give the UTC date. */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

/** Where the agent writes the full translation of a source. */
export function translationPathForIdentity(sourceIdentity: string): string {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  return `raw/translations/${withoutExt}.md`
}

/** Abort an agent run that produces no output at all within this window. */
export const AGENT_FIRST_OUTPUT_TIMEOUT_MS = 5 * 60 * 1000

export const AGENT_STARTUP_STALL_MESSAGE =
  "Agent 启动 5 分钟内没有任何输出，已停止。最常见的原因是 macOS 正在等待你授权本应用访问“iCloud 云盘/文稿”等文件夹（Codex 的技能目录可能指向 iCloud）：请到 系统设置 → 隐私与安全性 → 文件与文件夹 中为 LLM Wiki Tailored 打开权限，然后在活动面板重试。"

/**
 * Run one agent turn with a startup watchdog: a CLI that never emits anything
 * (typically blocked on a macOS privacy prompt) is stopped after 5 minutes
 * instead of hanging until the full subprocess timeout.
 */
export async function runAgentTurn(
  llmConfig: LlmConfig,
  prompt: string,
  signal: AbortSignal | undefined,
  overrides: Parameters<typeof streamChat>[4],
  firstOutputTimeoutMs = AGENT_FIRST_OUTPUT_TIMEOUT_MS,
  onActivity?: () => void,
): Promise<string> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener("abort", forwardAbort)
  let text = ""
  let sawOutput = false
  let stalled = false
  let failure: Error | null = null
  const watchdog = setTimeout(() => {
    if (!sawOutput) {
      stalled = true
      controller.abort()
    }
  }, firstOutputTimeoutMs)
  try {
    await streamChat(
      llmConfig,
      [{ role: "user", content: prompt }],
      {
        onToken: (token) => {
          sawOutput = true
          onActivity?.()
          text += token
        },
        onDone: () => {},
        onError: (err) => { failure = err },
      },
      controller.signal,
      {
        ...overrides,
        // Any CLI event (thread start, tool call, reasoning) proves the
        // agent is alive; only total silence trips the watchdog.
        agentOnActivity: () => {
          sawOutput = true
          onActivity?.()
        },
      },
    )
  } finally {
    clearTimeout(watchdog)
    signal?.removeEventListener("abort", forwardAbort)
  }
  if (stalled) {
    // A pending privacy prompt does not clear by itself; retrying only
    // burns another five minutes per attempt.
    throw Object.assign(new Error(AGENT_STARTUP_STALL_MESSAGE), { nonRetryable: true })
  }
  if (signal?.aborted) throw new Error("cancelled")
  if (failure) throw failure
  return text
}

/** Shown after 90s: the most common silent stall is a pending macOS privacy prompt. */
export const AGENT_STALL_HINT =
  " 若长时间没有进展，请检查 macOS 是否弹出了“访问文件夹/iCloud 云盘”的授权窗口并点“允许”。"

/** Marker the agent prints last, so an empty review list is still a non-empty reply. */
export const AGENT_INGEST_DONE_MARKER = "INGEST-COMPLETE"

export function agentInputPathForIdentity(sourceIdentity: string): string {
  const safe = sourceIdentity.replace(/[\\/]+/g, "__")
  return `.llm-wiki/agent-input/${safe}.md`
}

/**
 * Dominant writing system of a text by character share. The stock
 * detectLanguage() ignores ASCII, so an English report with a few CJK
 * characters (a fullwidth bracket in the title) is reported as Chinese.
 */
export function dominantScript(text: string): "latin" | "cjk" | "other" {
  const sample = text.slice(0, 40_000)
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length
  const cjk = (sample.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  if (latin === 0 && cjk === 0) return "other"
  // One CJK character carries roughly a word; weigh it against ~3 letters.
  return cjk * 3 >= latin ? "cjk" : "latin"
}

const CJK_TARGETS = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])

const ENGLISH_WORDS = ["the", "and", "of", "to", "in", "is", "for", "that", "with", "on"]
const LATIN_TARGET_WORDS: Record<string, string[]> = {
  French: ["le", "la", "les", "et", "des", "est", "une", "pour", "dans", "que"],
  German: ["der", "die", "und", "das", "ist", "nicht", "mit", "den", "von", "zu"],
  Spanish: ["el", "la", "los", "y", "que", "en", "del", "las", "por", "una"],
  Italian: ["il", "la", "che", "di", "e", "per", "una", "sono", "del", "non"],
  Portuguese: ["o", "a", "que", "de", "e", "do", "da", "em", "para", "uma"],
}

function looksLike(text: string, functionWords: string[]): boolean {
  const words = text.slice(0, 40_000).toLowerCase().match(/[a-zà-ÿ]+/g) ?? []
  if (words.length < 50) return false
  const set = new Set(functionWords)
  const hits = words.filter((w) => set.has(w)).length
  return hits / words.length >= 0.08
}

export function looksEnglish(text: string): boolean {
  return looksLike(text, ENGLISH_WORDS)
}

export function needsTranslation(sourceContent: string, targetLanguage: string): boolean {
  const configured = useWikiStore.getState().outputLanguage
  if (!configured || configured === "auto") return false
  const script = dominantScript(sourceContent)
  if (script === "latin") {
    // The script detector cannot tell Latin-script languages apart, so use
    // English function words: English → translate unless the target is
    // English; any other Latin-script language → translate into English, and
    // into a different non-English target.
    const english = looksEnglish(sourceContent)
    if (targetLanguage === "English") return !english
    return english || !LATIN_TARGET_WORDS[targetLanguage] || !looksLike(sourceContent, LATIN_TARGET_WORDS[targetLanguage])
  }
  if (script === "cjk") {
    if (!CJK_TARGETS.has(targetLanguage)) return true
    // CJK source into a CJK target: translate only across languages
    // (e.g. Japanese → Chinese), not Simplified ↔ Traditional Chinese.
    const source = detectLanguage(sourceContent.slice(0, 20_000))
    const chinese = new Set(["Chinese", "Traditional Chinese"])
    if (chinese.has(source) && chinese.has(targetLanguage)) return false
    return source !== targetLanguage
  }
  return detectLanguage(sourceContent.slice(0, 20_000)) !== targetLanguage
}

export interface AgentIngestPromptInput {
  sourceRelPath: string
  sourceIdentity: string
  inputRelPath: string
  sourceSummaryPath: string
  outputLanguage: string
  translationRelPath?: string
  imageRelPaths: string[]
  folderContext?: string
  today: string
}

export function buildAgentIngestPrompt(input: AgentIngestPromptInput): string {
  const lines = [
    "You are the ingest agent of this LLM Wiki project. Your working directory is the project root.",
    "Ingest exactly one source and finish in this single run. Work autonomously; never ask questions.",
    "",
    "## Source",
    `- Original file: ${input.sourceRelPath}`,
    `- Source identity (use it in every \`sources:\` list): ${input.sourceIdentity}`,
    `- Extracted text prepared by the app: ${input.inputRelPath}`,
  ]
  if (input.imageRelPaths.length > 0) {
    lines.push(
      `- Extracted images (${input.imageRelPaths.length}), open the ones that carry key evidence (charts, tables):`,
      ...input.imageRelPaths.slice(0, 60).map((p) => `  - ${p}`),
    )
  }
  if (input.folderContext) lines.push(`- Folder context: ${input.folderContext}`)
  lines.push(
    "",
    "## Steps",
    "1. Read purpose.md and schema.md in the project root, and any rule file they reference. They define what is worth a page, page types, directories and frontmatter. Follow them over anything below when they conflict.",
    "2. Read the extracted text. First locate where the disclosure section begins: the long legal block, usually at the END of the document, typically headed Required Disclosures / Important Disclosures / Analyst Certification / Disclaimer / 免责声明 / 分析师声明 / 重要声明. Ingest ONLY the content before that point; skip everything after it entirely, do not summarize it.",
    "   A short notice inside the body that merely points to the disclosures (e.g. \"disclosures begin on page 14\", \"see important disclosures at the end of this report\", a one-line conflict-of-interest note on page 1) is NOT the start of the section: keep reading the body after it. Sanity check: research reports put most of their pages into the body, so if your cut would discard most of the document, look again. Record the heading or first words where you cut, and the page range kept, in the source summary.",
  )
  let step = 3
  if (input.translationRelPath) {
    lines.push(
      `${step}. Translate the ingested part (everything before the disclosures) completely into ${input.outputLanguage}, section by section, keeping headings, tables, numbers, units and footnotes. Write it to ${input.translationRelPath}. A translation, not a summary.`,
    )
    step += 1
  }
  lines.push(
    `${step}. Search existing wiki pages (by name, aliases, tickers) before creating anything. Update an existing page instead of creating a duplicate. When updating, read the page first and rewrite it so it states the current understanding: keep other sources' contributions, move superseded statements into a change-log section with date, reason and source.`,
    `${step + 1}. Write the source summary to ${input.sourceSummaryPath} (type: source). Then create or update the knowledge pages schema.md calls for. Create a standalone page only when it meets schema.md's threshold.`,
    `${step + 2}. Every page you write has valid YAML frontmatter with at least: type, title, created, updated, tags, related, sources. \`sources\` lists source identities (here: ${input.sourceIdentity}). \`related\` lists page file names without .md. Use [[page-name]] wikilinks in the body. Dates are ${input.today}.`,
    `${step + 3}. Append one entry for today to wiki/log.md saying what this source changed (pages created / updated, views supported or challenged).`,
    "",
    "## Never",
    "- Modify anything under raw/ except the translation file named above, or purpose.md, schema.md, .obsidian/, .llm-wiki/.",
    "- Edit wiki/index.md or wiki/overview.md (the app maintains them).",
    "- Invent facts the source does not support. Unknown stays unknown.",
    "",
    "## Final message",
    "After writing the files, reply with review blocks for issues that genuinely need human judgment (contradictions between sources, facts you could not confirm, pages worth adding later), or none if there are none. Always end the reply with the line INGEST-COMPLETE. Review block format:",
    "---REVIEW: contradiction|duplicate|missing-page|confirm|suggestion | Short title---",
    "What the human needs to decide, with the evidence on each side.",
    "OPTIONS: option A | option B",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "---END REVIEW---",
    "",
    `Write all prose in ${input.outputLanguage}. Keep official names, tickers and technical terms in their original form.`,
  )
  return lines.join("\n")
}

function relToProject(projectPath: string, absPath: string): string {
  const pp = normalizePath(projectPath)
  const abs = normalizePath(absPath)
  return abs.startsWith(`${pp}/`) ? abs.slice(pp.length + 1) : abs
}

/**
 * Runs the whole ingest of one source as a single agent run. Must be called
 * inside the project commit lock: the agent writes wiki files directly.
 */
export async function runAgentIngest(
  ctx: AgentIngestContext,
  deps: AgentIngestDeps,
): Promise<string[]> {
  const pp = normalizePath(ctx.projectPath)
  const activity = useActivityStore.getState()
  const agentConfig = useAgentConfigStore.getState().config
  const outputLanguageCode = getOutputLanguage(ctx.sourceContent)
  const outputLanguage = getLanguagePromptName(outputLanguageCode)
  const translate = agentConfig.translateSources && needsTranslation(ctx.sourceContent, outputLanguageCode)
  const inputRelPath = agentInputPathForIdentity(ctx.sourceIdentity)
  const translationRelPath = translate ? translationPathForIdentity(ctx.sourceIdentity) : undefined

  await createDirectory(`${pp}/.llm-wiki/agent-input`)
  await writeFile(`${pp}/${inputRelPath}`, ctx.sourceContent)
  if (translationRelPath) {
    const dir = translationRelPath.slice(0, translationRelPath.lastIndexOf("/"))
    await createDirectory(`${pp}/${dir}`)
  }

  const prompt = buildAgentIngestPrompt({
    sourceRelPath: relToProject(pp, ctx.sourcePath),
    sourceIdentity: ctx.sourceIdentity,
    inputRelPath,
    sourceSummaryPath: ctx.sourceSummaryPath,
    outputLanguage,
    translationRelPath,
    imageRelPaths: ctx.savedImages.map((img) => `wiki/${img.relPath}`),
    folderContext: ctx.folderContext,
    today: localDate(),
  })

  const before = await snapshotWiki(pp)
  const startedAt = Date.now()
  let lastActivityAt = startedAt
  const ticker = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000)
    const quiet = Date.now() - lastActivityAt >= 90_000
    activity.updateItem(ctx.activityId, {
      detail: `Agent ingest running (${ctx.llmConfig.provider}, ${secs}s)${translate ? " — incl. translation" : ""}...${quiet ? AGENT_STALL_HINT : ""}`,
    })
  }, 2000)

  let finalText = ""
  try {
    finalText = await runAgentTurn(
      agentLlmConfig(ctx.llmConfig, agentConfig),
      prompt,
      ctx.signal,
      agentRequestOverrides(agentConfig),
      AGENT_FIRST_OUTPUT_TIMEOUT_MS,
      () => { lastActivityAt = Date.now() },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cancelled = ctx.signal?.aborted
    activity.updateItem(ctx.activityId, {
      status: "error",
      detail: cancelled ? "Ingest cancelled" : `Agent ingest failed: ${message}`,
    })
    throw cancelled ? new Error("Ingest cancelled") : err
  } finally {
    clearInterval(ticker)
  }

  const after = await snapshotWiki(pp)
  const { changed, deleted } = diffSnapshots(before, after)
  const writtenPaths = changed.filter((p) => p !== "wiki/index.md" && p !== "wiki/overview.md")
  for (const path of writtenPaths) ctx.onFileWritten?.(path)

  if (!writtenPaths.some((p) => normalizePath(p) === ctx.sourceSummaryPath)) {
    // The source summary is the one mandatory artifact; without it the
    // ingest did not happen. Throwing keeps the queue task retryable.
    const message = `Agent ingest finished without writing ${ctx.sourceSummaryPath}`
    activity.updateItem(ctx.activityId, { status: "error", detail: message, filesWritten: writtenPaths })
    throw new Error(message)
  }

  try {
    if (await pruneDeletedPagesFromIndex(pp, deleted) && !writtenPaths.includes("wiki/index.md")) {
      writtenPaths.push("wiki/index.md")
    }
  } catch (err) {
    console.warn("[agent-ingest] index prune failed:", err)
  }

  try {
    if (await deps.updateIndex(pp, writtenPaths) && !writtenPaths.includes("wiki/index.md")) {
      writtenPaths.push("wiki/index.md")
      ctx.onFileWritten?.("wiki/index.md")
    }
  } catch (err) {
    console.warn("[agent-ingest] index update failed:", err)
  }

  if (!writtenPaths.includes("wiki/log.md")) {
    try {
      const logPath = `${pp}/wiki/log.md`
      let existing = ""
      try { existing = await readFile(logPath) } catch { /* new log */ }
      await writeFile(logPath, deps.buildLog(existing, ctx.sourceIdentity))
      writtenPaths.push("wiki/log.md")
      ctx.onFileWritten?.("wiki/log.md")
    } catch (err) {
      console.warn("[agent-ingest] log update failed:", err)
    }
  }

  try {
    await deps.injectImages()
  } catch (err) {
    console.warn("[agent-ingest] image injection failed:", err)
  }

  try {
    await refreshProjectFileTree(pp, { bumpDataVersion: true })
  } catch {
    // ignore
  }

  const reviewItems = deps.parseReviews(finalText, ctx.sourcePath)
  if (reviewItems.length > 0) useReviewStore.getState().addItems(reviewItems)

  await saveIngestCache(pp, ctx.sourceIdentity, ctx.sourceContent, writtenPaths)
  // The extracted-text hand-off is only needed during the run.
  try { await deleteFile(`${pp}/${inputRelPath}`) } catch { /* ignore */ }
  await markPagesForAgentLint(pp, writtenPaths)
  await deps.embedPages(writtenPaths)

  const secs = Math.round((Date.now() - startedAt) / 1000)
  activity.updateItem(ctx.activityId, {
    status: "done",
    detail: [
      `Agent ingest: ${writtenPaths.length} files written in ${secs}s`,
      reviewItems.length > 0 ? `${reviewItems.length} review item(s)` : "",
      deleted.length > 0 ? `${deleted.length} page(s) merged away` : "",
      translationRelPath ? `translation → ${translationRelPath}` : "",
    ].filter(Boolean).join(", "),
    filesWritten: writtenPaths,
  })
  return writtenPaths
}

/** Title from frontmatter, used for embeddings. */
export function pageTitleFromContent(content: string, fallback: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  return typeof title === "string" && title.trim() ? title.trim() : fallback
}
