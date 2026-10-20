/**
 * Tailored LLM Wiki — agent settings.
 *
 * Agent mode hands a whole task (ingest one source, or health-check the wiki)
 * to a local coding agent (Codex CLI / Claude Code) in a single run. The agent
 * reads and writes files directly inside the project; the app then performs
 * its usual bookkeeping (index, log, review queue, ingest cache, embeddings).
 *
 * Kept in its own store file so upstream settings code stays untouched.
 */
import { create } from "zustand"
import type { LlmConfig } from "@/stores/wiki-store"

/** "default" leaves ~/.codex/config.toml alone; other values come from the model catalog. */
export type AgentReasoningEffort = string
export type AgentServiceTier = "default" | "priority"

export interface AgentConfig {
  /** Use one agent run per source instead of the multi-call pipeline. */
  ingestEnabled: boolean
  /** Translate non-target-language sources into raw/translations/ during ingest. */
  translateSources: boolean
  /** Run a scoped agent lint after each ingest batch drains. */
  lintAfterIngest: boolean
  /** Run a full-wiki agent lint every N days (0 = never automatically). */
  fullLintEveryDays: number
  /** Codex reasoning effort for agent runs. "default" leaves ~/.codex config alone. */
  reasoningEffort: AgentReasoningEffort
  /** Codex speed tier: "priority" is Fast (quicker, uses more subscription quota). */
  serviceTier: AgentServiceTier
  /** Model picked from the local Codex catalog ("" = use the LLM provider setting). */
  codexModel: string
  /** Claude Code model alias or ID ("" = use the LLM provider setting). */
  claudeModel: string
  /** Strip API-key env vars so agent runs always use the CLI subscription login. */
  subscriptionOnly: boolean
  /** Subprocess timeout for one agent run. */
  timeoutMinutes: number
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  ingestEnabled: true,
  translateSources: true,
  lintAfterIngest: true,
  fullLintEveryDays: 7,
  reasoningEffort: "medium",
  serviceTier: "default",
  codexModel: "",
  claudeModel: "",
  subscriptionOnly: true,
  timeoutMinutes: 60,
}

const STORE_FILE = "tailored-agent.json"
const STORE_KEY = "agentConfig"

export function normalizeAgentConfig(value: unknown): AgentConfig {
  const v = (value && typeof value === "object" ? value : {}) as Partial<AgentConfig>
  const effort = ["default", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
  return {
    ingestEnabled: v.ingestEnabled !== false,
    translateSources: v.translateSources !== false,
    lintAfterIngest: v.lintAfterIngest !== false,
    fullLintEveryDays: Number.isFinite(v.fullLintEveryDays)
      ? Math.max(0, Math.min(365, Math.round(Number(v.fullLintEveryDays))))
      : DEFAULT_AGENT_CONFIG.fullLintEveryDays,
    reasoningEffort: typeof v.reasoningEffort === "string" && effort.includes(v.reasoningEffort)
      ? v.reasoningEffort
      : DEFAULT_AGENT_CONFIG.reasoningEffort,
    serviceTier: v.serviceTier === "priority" ? "priority" : "default",
    codexModel: typeof v.codexModel === "string" ? v.codexModel.trim() : "",
    claudeModel: typeof v.claudeModel === "string" ? v.claudeModel.trim() : "",
    subscriptionOnly: v.subscriptionOnly !== false,
    timeoutMinutes: Number.isFinite(v.timeoutMinutes)
      ? Math.max(5, Math.min(240, Math.round(Number(v.timeoutMinutes))))
      : DEFAULT_AGENT_CONFIG.timeoutMinutes,
  }
}

interface AgentConfigState {
  config: AgentConfig
  setConfig: (config: AgentConfig) => void
}

export const useAgentConfigStore = create<AgentConfigState>((set) => ({
  config: DEFAULT_AGENT_CONFIG,
  setConfig: (config) => set({ config: normalizeAgentConfig(config) }),
}))

async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store")
  return load(STORE_FILE, { autoSave: true, defaults: {} })
}

export async function loadAgentConfig(): Promise<AgentConfig> {
  try {
    const store = await getStore()
    const config = normalizeAgentConfig(await store.get(STORE_KEY))
    useAgentConfigStore.getState().setConfig(config)
    return config
  } catch {
    return useAgentConfigStore.getState().config
  }
}

export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  const normalized = normalizeAgentConfig(config)
  useAgentConfigStore.getState().setConfig(normalized)
  const store = await getStore()
  await store.set(STORE_KEY, normalized)
}

/** Agent mode only applies to local CLI providers that can edit files. */
export function supportsAgentMode(llmConfig: Pick<LlmConfig, "provider">): boolean {
  return llmConfig.provider === "codex-cli" || llmConfig.provider === "claude-code"
}

export function agentIngestActive(llmConfig: Pick<LlmConfig, "provider">): boolean {
  return supportsAgentMode(llmConfig) && useAgentConfigStore.getState().config.ingestEnabled
}

export function agentRequestOverrides(config: AgentConfig = useAgentConfigStore.getState().config) {
  return {
    agentMode: true,
    agentReasoningEffort: config.reasoningEffort === "default" ? undefined : config.reasoningEffort,
    agentServiceTier: config.serviceTier === "priority" ? "priority" : undefined,
    agentTimeoutMinutes: config.timeoutMinutes,
    agentSubscriptionOnly: config.subscriptionOnly,
  }
}

/** The LLM config an agent run uses: the provider setting plus the model picked here. */
export function agentLlmConfig(
  llmConfig: LlmConfig,
  config: AgentConfig = useAgentConfigStore.getState().config,
): LlmConfig {
  if (llmConfig.provider === "codex-cli" && config.codexModel) {
    return { ...llmConfig, model: config.codexModel }
  }
  if (llmConfig.provider === "claude-code" && config.claudeModel) {
    return { ...llmConfig, model: config.claudeModel }
  }
  return llmConfig
}
