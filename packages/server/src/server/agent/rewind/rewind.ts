import type { AgentSession } from "../agent-sdk-types.js";

export type RewindMode = "conversation" | "files" | "both";

export class RewindCapabilityError extends Error {
  constructor(mode: RewindMode) {
    super(`Provider does not support rewinding ${mode}`);
    this.name = "RewindCapabilityError";
  }
}

export function resolveRewindCapability(
  session: AgentSession,
  mode: RewindMode,
): (input: { messageId: string }) => Promise<void> {
  switch (mode) {
    case "conversation":
      if (!session.capabilities.supportsRewindConversation || !session.revertConversation) {
        throw new RewindCapabilityError(mode);
      }
      return session.revertConversation.bind(session);
    case "files":
      if (!session.capabilities.supportsRewindFiles || !session.revertFiles) {
        throw new RewindCapabilityError(mode);
      }
      return session.revertFiles.bind(session);
    case "both":
      if (!session.capabilities.supportsRewindBoth || !session.revertBoth) {
        throw new RewindCapabilityError(mode);
      }
      return session.revertBoth.bind(session);
  }
}
