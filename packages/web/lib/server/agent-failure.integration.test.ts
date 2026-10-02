import { afterAll, beforeAll, describe, expect, it } from "vitest"

const databaseDescribe = process.env.DATABASE_URL ? describe : describe.skip

databaseDescribe("failed turn persistence on a real database", () => {
  const run = crypto.randomUUID()
  let prisma: typeof import("@/lib/db/prisma").prisma
  let userId: string
  let chatId: string
  const assistantMessageId = `failure-assistant-${run}`
  const backgroundSessionId = `failure-run-${run}`

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/db/prisma"))
    const user = await prisma.user.create({ data: { email: `agent-failure-${run}@example.test` } })
    userId = user.id
    const chat = await prisma.chat.create({
      data: { userId, repo: "__new__", status: "running", backgroundSessionId, activeAssistantMessageId: assistantMessageId },
    })
    chatId = chat.id
    await prisma.message.create({
      data: { id: assistantMessageId, chatId, role: "assistant", content: "", timestamp: 1n, metadata: { pool: "shared" } },
    })
  })

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("keeps partial output and failure after release, with one safe event for overlapping observers", async () => {
    const { claimTurnFinalization, releaseTurn } = await import("./turn-ownership")
    const { persistAgentSnapshot } = await import("@/app/api/agent/stream/_lib/persist-snapshot")
    const { describeAgentFailure } = await import("./agent-failure")
    const { logAgentFailure } = await import("@/lib/db/activity-log")
    const turn = { chatId, backgroundSessionId, assistantMessageId }
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimTurnFinalization(turn)))
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claimId = claims.find(Boolean)!
    const snapshot = {
      status: "error" as const, content: "partial answer", toolCalls: [], contentBlocks: [],
      sessionId: "cli-session", error: "Process exited; API_KEY=super-secret-value", errorKind: "crash" as const,
    }
    expect((await persistAgentSnapshot({
      prisma, turn, snapshot, finalizationClaimId: claimId, failure: describeAgentFailure(snapshot),
    })).persisted).toBe(true)
    await Promise.all(["stream", "cron-interactive"].map((source) => logAgentFailure({
      userId, chatId, assistantMessageId, source: source as "stream" | "cron-interactive",
      error: snapshot.error, errorKind: "crash",
    })))
    expect(await releaseTurn(turn, claimId, "error")).toBe(true)

    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })
    const message = await prisma.message.findUniqueOrThrow({ where: { id: assistantMessageId } })
    const events = await prisma.activityLog.findMany({ where: { userId, action: "agent_failure" } })
    expect(chat.status).toBe("error")
    expect(chat.backgroundSessionId).toBeNull()
    expect(message.content).toBe("partial answer")
    expect(message.metadata).toMatchObject({ pool: "shared", failure: { kind: "crash" } })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain("super-secret-value")
  })
})
