import type { AgentStreamEvent } from "./agent-sdk-types.js";

export function isCodexCapacityStop(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_failed" &&
    event.provider === "codex" &&
    event.error === "Selected model is at capacity. Please try a different model."
  );
}

export function isContinuationStop(event: AgentStreamEvent): boolean {
  return (
    (event.type === "turn_failed" &&
      event.provider === "claude" &&
      event.subscriptionLimit?.type === "five_hour") ||
    isCodexCapacityStop(event)
  );
}
