import { prisma, MessageRole } from "@telephony/database";
import { AgentMessage, AgentRole } from "./ai/types";

export const ROLE_TO_DB: Record<AgentRole, MessageRole> = {
  user: MessageRole.USER,
  assistant: MessageRole.ASSISTANT,
  system: MessageRole.SYSTEM,
  tool: MessageRole.TOOL,
};

export const DB_TO_ROLE: Record<MessageRole, AgentRole> = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
};

/** Loads the full conversation so far for a call, oldest first. Shared by the
 * webhook-driven turn loop and the streaming call-session loop. */
export async function loadHistory(callId: string): Promise<AgentMessage[]> {
  const rows = await prisma.conversationMessage.findMany({
    where: { callId },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({
    role: DB_TO_ROLE[row.role],
    content: row.content,
    toolName: row.toolName ?? undefined,
    toolArgs: (row.toolArgs as Record<string, unknown> | null) ?? undefined,
  }));
}
