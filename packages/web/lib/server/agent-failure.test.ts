import { describe, expect, it } from "vitest"
import { describeAgentFailure } from "./agent-failure"
import type { AgentSnapshot } from "@/lib/agent-session"

const failedSnapshot = (error: string, errorKind: "crash" | "incomplete"): AgentSnapshot => ({
  status: "error", content: "partial output", toolCalls: [], contentBlocks: [],
  sessionId: "session", error, errorKind,
})

describe("describeAgentFailure", () => {
  it("does not persist stderr or secrets for a process crash", () => {
    const failure = describeAgentFailure(failedSnapshot("Process exited; TOKEN=secret", "crash"))
    expect(failure).toEqual({ kind: "crash", message: "Agent process exited before completing." })
  })

  it("labels a provider rejection instead of an apparent process crash", () => {
    const failure = describeAgentFailure(failedSnapshot("Invalid API key: 401 Unauthorized", "crash"))
    expect(failure).toEqual({ kind: "crash", message: "Agent failed: auth error." })
  })

  it("distinguishes a truncated stream from a crashed process", () => {
    const failure = describeAgentFailure(failedSnapshot("Stream ended unexpectedly", "incomplete"))
    expect(failure).toEqual({ kind: "incomplete", message: "Agent stopped before completing." })
  })
})
