import { classifyAgentError } from "@background-agents/sdk"
import type { AgentSnapshot } from "@/lib/agent-session"
import type { AgentFailure } from "@/lib/types"

/** Persist a useful, bounded status without copying CLI stderr or credentials. */
export function describeAgentFailure(snapshot: AgentSnapshot): AgentFailure {
  const kind = snapshot.errorKind ?? "agent"
  const { category } = classifyAgentError(snapshot.error ?? "")
  // A provider rejection can make the CLI exit. Tell the user what failed,
  // rather than mislabeling that exit as a generic process crash.
  if (category !== "unknown") {
    return { kind, message: `Agent failed: ${category} error.` }
  }
  if (kind === "crash") {
    return { kind, message: "Agent process exited before completing." }
  }
  if (kind === "incomplete") {
    return { kind, message: "Agent stopped before completing." }
  }
  return { kind, message: "Agent failed before completing." }
}
