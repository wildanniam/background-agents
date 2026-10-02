import { Prisma } from "@prisma/client"
import type { AgentSnapshot } from "@/lib/agent-session"
import { stripNullBytes, stripNullBytesDeep } from "@/lib/db/pg-sanitize"
import type { ActiveTurn } from "@/lib/server/turn-ownership"
import type { AgentFailure } from "@/lib/types"

type SnapshotStore = {
  message: {
    update: (args: Prisma.MessageUpdateArgs) => Promise<unknown>
    findUnique: (args: Prisma.MessageFindUniqueArgs) => Promise<{ metadata: Prisma.JsonValue | null } | null>
  }
  chat: { updateMany: (args: Prisma.ChatUpdateManyArgs) => Promise<{ count: number }> }
}

export interface SnapshotPersistClient extends SnapshotStore {
  $transaction: <T>(fn: (tx: SnapshotStore) => Promise<T>) => Promise<T>
}

/** A periodic write holds the chat row lock through the message write. */
export async function persistAgentSnapshot(params: {
  prisma: SnapshotPersistClient
  turn: ActiveTurn
  snapshot: AgentSnapshot
  finalizationClaimId?: string
  failure?: AgentFailure
}): Promise<{ persisted: boolean }> {
  const { prisma, turn, snapshot, finalizationClaimId, failure } = params
  try {
    return await prisma.$transaction(async (tx) => {
      const owned = await tx.chat.updateMany({
        where: {
          id: turn.chatId,
          status: "running",
          backgroundSessionId: turn.backgroundSessionId,
          activeAssistantMessageId: turn.assistantMessageId,
          finalizationClaimId: finalizationClaimId ?? null,
        },
        // A no-op update acquires the row lock so a finalizer cannot release
        // the chat and start the next turn before this write commits.
        data: { queueSequence: { increment: 0 } },
      })
      if (owned.count !== 1) return { persisted: false }

      const existing = failure
        ? await tx.message.findUnique({ where: { id: turn.assistantMessageId }, select: { metadata: true } })
        : null
      const metadata = existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, unknown>
        : {}

      await tx.message.update({
        where: { id: turn.assistantMessageId },
        data: {
          content: stripNullBytes(snapshot.content),
          toolCalls: snapshot.toolCalls.length > 0
            ? (stripNullBytesDeep(snapshot.toolCalls) as unknown as Prisma.InputJsonValue)
            : undefined,
          contentBlocks: snapshot.contentBlocks.length > 0
            ? (stripNullBytesDeep(snapshot.contentBlocks) as unknown as Prisma.InputJsonValue)
            : undefined,
          metadata: failure
            ? ({ ...metadata, failure } as unknown as Prisma.InputJsonValue)
            : undefined,
        },
      })
      return { persisted: true }
    })
  } catch (error) {
    // Message persistence must not keep a claimed finalizer from releasing the
    // chat. Callers release in a separate, guarded operation even on failure.
    console.error("[agent/stream] message persist error:", error)
    return { persisted: false }
  }
}
