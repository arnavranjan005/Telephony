export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";

export interface ConversationMessage {
  id: string;
  callId: string;
  role: MessageRole;
  content: string;
  toolName: string | null;
  toolArgs: unknown;
  interrupted: boolean;
  createdAt: string;
}
