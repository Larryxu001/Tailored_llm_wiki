/**
 * Tailored LLM Wiki — model catalogs for agent runs, so the user picks a model
 * and speed from what the installed CLI actually offers instead of typing a
 * model name that must match the terminal.
 *
 * Codex keeps the catalog the CLI itself downloaded at ~/.codex/models_cache.json
 * (refreshed whenever Codex runs). Claude Code accepts aliases that always
 * resolve to the newest model of each family.
 */
import { readFile } from "@/commands/fs"

export interface AgentModelOption {
  id: string
  label: string
  description?: string
  reasoningLevels: string[]
  defaultReasoning?: string
  supportsFast: boolean
}

interface CodexCacheModel {
  slug?: string
  display_name?: string
  description?: string
  visibility?: string
  priority?: number
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{ effort?: string } | string>
  service_tiers?: Array<{ id?: string }>
  additional_speed_tiers?: string[]
}

export function parseCodexModelsCache(raw: string): AgentModelOption[] {
  let parsed: { models?: CodexCacheModel[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const models = Array.isArray(parsed.models) ? parsed.models : []
  return models
    .filter((m) => typeof m.slug === "string" && m.slug && m.visibility !== "hide")
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((m) => ({
      id: m.slug as string,
      label: m.display_name || (m.slug as string),
      description: m.description,
      reasoningLevels: (m.supported_reasoning_levels ?? [])
        .map((level) => (typeof level === "string" ? level : level.effort))
        .filter((level): level is string => typeof level === "string" && level.length > 0),
      defaultReasoning: m.default_reasoning_level,
      supportsFast:
        (m.service_tiers ?? []).some((tier) => tier.id === "priority") ||
        (m.additional_speed_tiers ?? []).includes("fast"),
    }))
}

export async function loadCodexModels(): Promise<AgentModelOption[]> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path")
    const home = (await homeDir()).replace(/\/+$/, "")
    return parseCodexModelsCache(await readFile(`${home}/.codex/models_cache.json`))
  } catch {
    return []
  }
}

/** Claude Code aliases always resolve to the latest model of that family. */
export const CLAUDE_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "opus", label: "Opus（最新）", description: "最强推理，适合长研报和全库体检", reasoningLevels: [], supportsFast: false },
  { id: "sonnet", label: "Sonnet（最新）", description: "速度与质量平衡，适合日常摄入", reasoningLevels: [], supportsFast: false },
  { id: "fable", label: "Fable（最新）", description: "最新一代", reasoningLevels: [], supportsFast: false },
  { id: "haiku", label: "Haiku（最新）", description: "最快，适合简单材料", reasoningLevels: [], supportsFast: false },
]
