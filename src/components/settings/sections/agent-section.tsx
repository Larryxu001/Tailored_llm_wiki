import { useEffect, useState } from "react"
import { Bot, Stethoscope } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import {
  saveAgentConfig,
  supportsAgentMode,
  useAgentConfigStore,
  type AgentConfig,
} from "@/lib/agent-config"
import { CLAUDE_MODEL_OPTIONS, loadCodexModels, type AgentModelOption } from "@/lib/agent-models"
import { loadAgentLintState, type AgentLintState } from "@/lib/agent-lint-state"
import { isAgentLintRunning, runAgentLint } from "@/lib/agent-lint"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"

/**
 * Tailored LLM Wiki — Agent mode settings. Persists inline (no global Save).
 */
export function AgentSection() {
  const config = useAgentConfigStore((s) => s.config)
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [lintState, setLintState] = useState<AgentLintState | null>(null)
  const [message, setMessage] = useState("")
  const [codexModels, setCodexModels] = useState<AgentModelOption[]>([])
  const supported = supportsAgentMode(llmConfig)
  const isCodex = llmConfig.provider === "codex-cli"
  const isClaude = llmConfig.provider === "claude-code"

  useEffect(() => {
    if (isCodex) void loadCodexModels().then(setCodexModels)
  }, [isCodex])

  const models = isCodex ? codexModels : isClaude ? CLAUDE_MODEL_OPTIONS : []
  const selectedModelId = isCodex ? config.codexModel : config.claudeModel
  const effectiveModelId = selectedModelId || llmConfig.model
  const selectedModel = models.find((m) => m.id === effectiveModelId)
  const reasoningLevels = selectedModel?.reasoningLevels.length
    ? selectedModel.reasoningLevels
    : ["low", "medium", "high", "xhigh"]

  useEffect(() => {
    if (!project) return
    void loadAgentLintState(project.path).then(setLintState)
  }, [project])

  const update = (patch: Partial<AgentConfig>) => {
    void saveAgentConfig({ ...config, ...patch })
  }

  const runLint = async (kind: "pending" | "full") => {
    if (!project) return
    if (isAgentLintRunning()) {
      setMessage("体检正在运行，请在活动面板查看进度。")
      return
    }
    setMessage("体检已开始，请在活动面板查看进度。")
    try {
      const state = await loadAgentLintState(project.path)
      const result = await runAgentLint(
        project.path,
        getTaskLlmConfig("ingest"),
        kind === "full" ? { kind: "full" } : { kind: "pending", pages: state.pendingPages },
      )
      setMessage(
        result.skipped ??
          `体检完成：修改 ${result.changedPages.length} 个文件，合并 ${result.deletedPages.length} 个重复页，${result.reviewItems} 条进入待审阅。`,
      )
    } catch (err) {
      setMessage(`体检失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLintState(await loadAgentLintState(project.path))
    }
  }

  const checkbox = (
    key: "ingestEnabled" | "translateSources" | "lintAfterIngest" | "subscriptionOnly",
    title: string,
    description: string,
  ) => (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={config[key]}
        onChange={(event) => update({ [key]: event.target.checked } as Partial<AgentConfig>)}
        className="mt-1 h-4 w-4"
      />
      <div className="space-y-1">
        <div className="text-sm font-semibold">{title}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </label>
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Bot className="h-5 w-5" /> Agent 模式
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          把一整篇摄入或一次体检交给本机的 Codex CLI / Claude Code 一次完成，使用你登录的订阅额度。
        </p>
        <p className={`mt-2 text-xs ${supported ? "text-emerald-600" : "text-amber-600"}`}>
          {supported
            ? `当前模型提供方：${llmConfig.provider}（${llmConfig.model}），可以使用 Agent 模式。`
            : `当前模型提供方是 ${llmConfig.provider}。Agent 模式只支持 Codex CLI 或 Claude Code，其他提供方会自动使用原版摄入流程。`}
        </p>
      </div>

      <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        {checkbox(
          "ingestEnabled",
          "Agent 摄入",
          "每份原文只调用一次 agent：它读原文、跳过免责声明、查已有页面并直接改写。关闭则使用原版的多轮流程。",
        )}
        {checkbox(
          "translateSources",
          "摄入时全文翻译",
          "当“输出语言”不是“自动”且原文语言不同时，把正文（免责声明之前）全文翻译到 raw/translations/。",
        )}
        {checkbox(
          "lintAfterIngest",
          "每批摄入后自动体检",
          "摄入队列跑完后，对本批改动过的页面及其相邻页面做一次 Agent 体检：机械问题直接修，判断题进入待审阅。",
        )}

        {checkbox(
          "subscriptionOnly",
          "只用订阅额度",
          "Agent 运行时忽略 OPENAI_API_KEY / ANTHROPIC_API_KEY 等环境变量，始终使用 codex / claude 命令行登录的订阅账号。只用 API Key 登录的用户请关闭。",
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <div className="font-semibold">模型</div>
            <select
              value={selectedModelId}
              disabled={!supported}
              onChange={(event) =>
                update(isCodex ? { codexModel: event.target.value } : { claudeModel: event.target.value })
              }
              className="w-full rounded border border-border bg-background px-2 py-1"
            >
              <option value="">跟随“LLM 模型”设置（{llmConfig.model || "未填写"}）</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.description ? ` — ${m.description}` : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {isCodex
                ? codexModels.length > 0
                  ? `已读取本机 Codex 的 ${codexModels.length} 个可用模型（每次运行 Codex 会自动刷新）。`
                  : "没有读到 ~/.codex/models_cache.json，先在终端运行一次 codex 即可生成。"
                : isClaude
                  ? "Claude Code 的别名总是指向该系列的最新模型。"
                  : ""}
            </p>
          </label>
          {isCodex && (
            <label className="space-y-1 text-sm">
              <div className="font-semibold">推理强度</div>
              <select
                value={config.reasoningEffort}
                onChange={(event) => update({ reasoningEffort: event.target.value })}
                className="w-full rounded border border-border bg-background px-2 py-1"
              >
                <option value="default">沿用 ~/.codex/config.toml</option>
                {reasoningLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                    {selectedModel?.defaultReasoning === level ? "（模型默认）" : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">摄入研报建议 medium；越高越慢。</p>
            </label>
          )}
          {isCodex && (
            <label className="space-y-1 text-sm">
              <div className="font-semibold">速度</div>
              <select
                value={config.serviceTier}
                disabled={selectedModel ? !selectedModel.supportsFast : false}
                onChange={(event) => update({ serviceTier: event.target.value === "priority" ? "priority" : "default" })}
                className="w-full rounded border border-border bg-background px-2 py-1"
              >
                <option value="default">标准</option>
                <option value="priority">Fast（约 2 倍速度，消耗更多订阅额度）</option>
              </select>
            </label>
          )}
          <label className="space-y-1 text-sm">
            <div className="font-semibold">全库体检间隔（天）</div>
            <input
              type="number"
              min={0}
              max={365}
              key={`fullLintEveryDays-${config.fullLintEveryDays}`}
              defaultValue={config.fullLintEveryDays}
              onBlur={(event) => update({ fullLintEveryDays: Number(event.target.value) })}
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
            <p className="text-xs text-muted-foreground">0 表示不自动做全库体检。</p>
          </label>
          <label className="space-y-1 text-sm">
            <div className="font-semibold">单次超时（分钟）</div>
            <input
              type="number"
              min={5}
              max={240}
              key={`timeoutMinutes-${config.timeoutMinutes}`}
              defaultValue={config.timeoutMinutes}
              onBlur={(event) => update({ timeoutMinutes: Number(event.target.value) })}
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </label>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Stethoscope className="h-4 w-4" /> 手动体检
        </div>
        {lintState && (
          <p className="text-xs text-muted-foreground">
            待体检页面 {lintState.pendingPages.length} 个；上次全库体检：
            {lintState.lastFullLintRunAt ? new Date(lintState.lastFullLintRunAt).toLocaleString() : "从未"}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!project || !supported}
            onClick={() => void runLint("pending")}
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
          >
            体检本次改动
          </button>
          <button
            type="button"
            disabled={!project || !supported}
            onClick={() => void runLint("full")}
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
          >
            全库体检
          </button>
        </div>
        {message && <p className="text-xs">{message}</p>}
      </div>
    </div>
  )
}
