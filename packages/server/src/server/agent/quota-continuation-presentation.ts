import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

// A read model of ScheduleService's durable jobs, never a provider run or a second job store.
// Rebuilt before directory snapshots at daemon startup; old clients use their existing Stop button.
const pending = new Set<string>();

export function quotaContinuationStatus(
  agentId: string,
  status: AgentLifecycleStatus,
  archivedAt?: string | null,
): AgentLifecycleStatus {
  return pending.has(agentId) && !archivedAt ? "running" : status;
}

export function setQuotaContinuationPending(agentId: string, value: boolean): void {
  if (value) pending.add(agentId);
  else pending.delete(agentId);
}

export function hasQuotaContinuationPending(agentId: string): boolean {
  return pending.has(agentId);
}
