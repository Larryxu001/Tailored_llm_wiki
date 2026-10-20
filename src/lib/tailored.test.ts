import { describe, expect, it, beforeEach } from "vitest"
import {
  isRawSourceRelPath,
  rawSourceIdentityFromRel,
  rawSourceRelCandidates,
  filterRawLayoutTree,
} from "./raw-layout"
import { sourceIdentityForPath, sourceReferenceIdentity } from "./source-identity"
import { parseCodexModelsCache } from "./agent-models"
import { parseAgentReviewBlocks, buildAgentLintPrompt } from "./agent-lint"
import {
  buildAgentIngestPrompt,
  diffSnapshots,
  dominantScript,
  localDate,
  needsTranslation,
  translationPathForIdentity,
} from "./agent-ingest"
import { agentLlmConfig, normalizeAgentConfig, DEFAULT_AGENT_CONFIG } from "./agent-config"
import { fullLintDue, isLintablePage } from "./agent-lint-state"
import { parsedMarkdownOutputPath } from "./parsed-source-output"
import { useWikiStore } from "@/stores/wiki-store"

describe("relaxed raw/ layout", () => {
  it("treats any file under raw/ as a source except reserved and hidden folders", () => {
    expect(isRawSourceRelPath("raw/sources/a.md")).toBe(true)
    expect(isRawSourceRelPath("raw/海外投行/2026-10/report.pdf")).toBe(true)
    expect(isRawSourceRelPath("raw/report.pdf")).toBe(true)
    expect(isRawSourceRelPath("raw/assets/img.png")).toBe(false)
    expect(isRawSourceRelPath("raw/parsed/report.pdf.md")).toBe(false)
    expect(isRawSourceRelPath("raw/translations/report.md")).toBe(false)
    expect(isRawSourceRelPath("raw/海外投行/.cache/report.pdf.txt")).toBe(false)
    expect(isRawSourceRelPath("wiki/a.md")).toBe(false)
  })

  it("keeps legacy identities and relaxes new ones", () => {
    expect(rawSourceIdentityFromRel("raw/sources/券商A/x.pdf")).toBe("券商A/x.pdf")
    expect(rawSourceIdentityFromRel("raw/海外投行/x.pdf")).toBe("海外投行/x.pdf")
    expect(rawSourceRelCandidates("海外投行/x.pdf")).toEqual(["raw/sources/海外投行/x.pdf", "raw/海外投行/x.pdf"])
    expect(sourceIdentityForPath("/p", "/p/raw/sources/a/b.pdf")).toBe("a/b.pdf")
    expect(sourceIdentityForPath("/p", "/p/raw/海外投行/b.pdf")).toBe("海外投行/b.pdf")
    expect(sourceReferenceIdentity("raw/海外投行/b.pdf")).toBe("海外投行/b.pdf")
    expect(sourceReferenceIdentity("海外投行/b.pdf")).toBe("海外投行/b.pdf")
  })

  it("hides reserved folders from the raw tree", () => {
    const nodes = [
      { name: "sources", path: "/p/raw/sources", is_dir: true, children: [] },
      { name: "assets", path: "/p/raw/assets", is_dir: true, children: [] },
      { name: "海外投行", path: "/p/raw/海外投行", is_dir: true, children: [] },
      { name: "translations", path: "/p/raw/translations", is_dir: true, children: [] },
    ]
    expect(filterRawLayoutTree(nodes).map((n) => n.name)).toEqual(["sources", "海外投行"])
  })

  it("maps parsed markdown of relaxed sources under raw/parsed/", () => {
    expect(parsedMarkdownOutputPath("/p", "/p/raw/海外投行/x.pdf")).toBe("/p/raw/parsed/海外投行/x.pdf.md")
    expect(parsedMarkdownOutputPath("/p", "/p/raw/sources/x.pdf")).toBe("/p/raw/parsed/x.pdf.md")
    expect(parsedMarkdownOutputPath("/p", "/p/raw/translations/x.md")).toBeNull()
  })
})

describe("agent model catalog", () => {
  it("parses the Codex models cache, hiding hidden models", () => {
    const raw = JSON.stringify({
      models: [
        {
          slug: "gpt-b", display_name: "B", visibility: "list", priority: 2,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        },
        {
          slug: "gpt-a", display_name: "A", visibility: "list", priority: 1,
          default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
          service_tiers: [{ id: "priority" }],
        },
        { slug: "hidden", visibility: "hide" },
      ],
    })
    const models = parseCodexModelsCache(raw)
    expect(models.map((m) => m.id)).toEqual(["gpt-a", "gpt-b"])
    expect(models[0].reasoningLevels).toEqual(["low", "ultra"])
    expect(models[0].supportsFast).toBe(true)
    expect(models[1].supportsFast).toBe(false)
    expect(parseCodexModelsCache("not json")).toEqual([])
  })

  it("overrides the model only for agent runs of the matching provider", () => {
    const base = { ...useWikiStore.getState().llmConfig, provider: "codex-cli" as const, model: "typed" }
    const cfg = { ...DEFAULT_AGENT_CONFIG, codexModel: "gpt-6.1-sol" }
    expect(agentLlmConfig(base, cfg).model).toBe("gpt-6.1-sol")
    expect(agentLlmConfig({ ...base, provider: "claude-code" }, cfg).model).toBe("typed")
    expect(agentLlmConfig(base, DEFAULT_AGENT_CONFIG).model).toBe("typed")
  })

  it("normalizes stored agent config", () => {
    expect(normalizeAgentConfig({ reasoningEffort: "bogus", serviceTier: "x", timeoutMinutes: 1 })).toMatchObject({
      reasoningEffort: "medium",
      serviceTier: "default",
      timeoutMinutes: 5,
      ingestEnabled: true,
    })
    expect(normalizeAgentConfig({ reasoningEffort: "ultra", serviceTier: "priority" })).toMatchObject({
      reasoningEffort: "ultra",
      serviceTier: "priority",
    })
  })
})

describe("agent ingest helpers", () => {
  beforeEach(() => {
    useWikiStore.getState().setOutputLanguage("auto")
  })

  it("diffs wiki snapshots into changed and deleted pages", () => {
    const before = new Map([["wiki/a.md", "1:1"], ["wiki/b.md", "1:1"], ["wiki/c.md", "1:1"]])
    const after = new Map([["wiki/a.md", "1:1"], ["wiki/b.md", "2:5"], ["wiki/d.md", "3:3"]])
    expect(diffSnapshots(before, after)).toEqual({ changed: ["wiki/b.md", "wiki/d.md"], deleted: ["wiki/c.md"] })
  })

  it("translates only when an explicit output language differs from the source", () => {
    const english = "The company reported strong revenue growth driven by AI servers. ".repeat(20)
    expect(needsTranslation(english, "Chinese")).toBe(false) // auto
    useWikiStore.getState().setOutputLanguage("Chinese")
    expect(needsTranslation(english, "Chinese")).toBe(true)
    expect(needsTranslation("中际旭创的光模块业务继续增长。".repeat(20), "Chinese")).toBe(false)
    expect(translationPathForIdentity("海外投行/2026-10/JPM x.pdf")).toBe("raw/translations/海外投行/2026-10/JPM x.md")
    // English report with a few CJK characters (fullwidth brackets in a title)
    const mostlyEnglish = "SK Hynix（000660）Re-rating likely ahead. " + english
    expect(dominantScript(mostlyEnglish)).toBe("latin")
    expect(needsTranslation(mostlyEnglish, "Chinese")).toBe(true)
    expect(needsTranslation("日本のメモリ市場は拡大している。".repeat(30), "Chinese")).toBe(true)
    expect(needsTranslation("中际旭创的光模块业务继续增长。".repeat(20), "Traditional Chinese")).toBe(false)
    useWikiStore.getState().setOutputLanguage("English")
    expect(needsTranslation(english, "English")).toBe(false)
    expect(needsTranslation("中际旭创的光模块业务继续增长。".repeat(20), "English")).toBe(true)
    expect(localDate(new Date(2026, 9, 21, 0, 30))).toBe("2026-10-21")
  })

  it("builds a prompt that enforces disclosures-skip, the summary path and review format", () => {
    const prompt = buildAgentIngestPrompt({
      sourceRelPath: "raw/海外投行/x.pdf",
      sourceIdentity: "海外投行/x.pdf",
      inputRelPath: ".llm-wiki/agent-input/x.md",
      sourceSummaryPath: "wiki/sources/x.md",
      outputLanguage: "Chinese",
      translationRelPath: "raw/translations/海外投行/x.md",
      imageRelPaths: ["wiki/media/x/img-1.png"],
      today: "2026-10-21",
    })
    expect(prompt).toContain("disclosures")
    expect(prompt).toContain("wiki/sources/x.md")
    expect(prompt).toContain("raw/translations/海外投行/x.md")
    expect(prompt).toContain("---REVIEW:")
    expect(prompt).toContain("purpose.md and schema.md")
    expect(prompt).toContain("INGEST-COMPLETE")
    expect(prompt).toContain("disclosures begin on page 14")
  })
})

describe("agent lint helpers", () => {
  it("parses review blocks from the agent's final message", () => {
    const items = parseAgentReviewBlocks([
      "---REVIEW: contradiction | 天孚通信业绩口径冲突---",
      "花旗称超预期，摩根士丹利称不及预期。",
      "OPTIONS: 以花旗为准 | 并列保留",
      "PAGES: wiki/entities/tianfu.md",
      "---END REVIEW---",
      "---REVIEW: weird | 其他---",
      "x",
      "---END REVIEW---",
    ].join("\n"))
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      type: "contradiction",
      title: "天孚通信业绩口径冲突",
      affectedPages: ["wiki/entities/tianfu.md"],
    })
    expect(items[0].options.map((o) => o.label)).toEqual(["以花旗为准", "并列保留"])
    expect(items[1].type).toBe("confirm")
  })

  it("scopes the lint prompt and protects human-owned paragraphs", () => {
    const pending = buildAgentLintPrompt({ kind: "pending", pages: ["wiki/entities/a.md"] }, "Chinese", "2026-10-21")
    expect(pending).toContain("wiki/entities/a.md")
    expect(pending).toContain("%%人工%%")
    expect(buildAgentLintPrompt({ kind: "full" }, "Chinese", "2026-10-21")).toContain("WHOLE wiki")
  })

  it("schedules full lints and filters lintable pages", () => {
    const day = 24 * 60 * 60 * 1000
    const state = { version: 1 as const, pendingPages: [], lastFullLintAt: 0, lastLintAt: null }
    expect(fullLintDue({ ...state, lastFullLintAt: null }, 7)).toBe(false)
    expect(fullLintDue(state, 7, 6 * day)).toBe(false)
    expect(fullLintDue(state, 7, 7 * day)).toBe(true)
    expect(fullLintDue(state, 0, 100 * day)).toBe(false)
    expect(isLintablePage("wiki/entities/a.md")).toBe(true)
    expect(isLintablePage("wiki/index.md")).toBe(false)
    expect(isLintablePage("raw/x.md")).toBe(false)
  })
})
