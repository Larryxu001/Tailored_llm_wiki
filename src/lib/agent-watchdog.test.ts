import { describe, expect, it, vi } from "vitest"

const streamChat = vi.fn()
vi.mock("@/lib/llm-client", () => ({ streamChat: (...args: unknown[]) => streamChat(...args) }))

import { runAgentTurn, AGENT_STARTUP_STALL_MESSAGE } from "./agent-ingest"
import { useWikiStore } from "@/stores/wiki-store"

const config = { ...useWikiStore.getState().llmConfig, provider: "codex-cli" as const, model: "m" }

describe("agent startup watchdog", () => {
  it("stops a run that emits nothing at all", async () => {
    streamChat.mockImplementation((_c, _m, callbacks, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { callbacks.onDone(); resolve() })
      }))
    const err = await runAgentTurn(config, "p", undefined, {}, 30).catch((e) => e)
    expect(err.message).toBe(AGENT_STARTUP_STALL_MESSAGE)
    expect(err.nonRetryable).toBe(true)
  })

  it("keeps a run alive that only emits tool events, then returns its text", async () => {
    streamChat.mockImplementation((_c, _m, callbacks, _signal: AbortSignal, overrides: { agentOnActivity?: () => void }) =>
      new Promise<void>((resolve) => {
        overrides.agentOnActivity?.()
        setTimeout(() => {
          callbacks.onToken("INGEST-COMPLETE")
          callbacks.onDone()
          resolve()
        }, 80)
      }))
    await expect(runAgentTurn(config, "p", undefined, {}, 30)).resolves.toBe("INGEST-COMPLETE")
  })

  it("surfaces CLI errors", async () => {
    streamChat.mockImplementation((_c, _m, callbacks) => {
      callbacks.onError(new Error("Codex CLI exited with code 1"))
      return Promise.resolve()
    })
    await expect(runAgentTurn(config, "p", undefined, {}, 1000)).rejects.toThrow("exited with code 1")
  })
})
