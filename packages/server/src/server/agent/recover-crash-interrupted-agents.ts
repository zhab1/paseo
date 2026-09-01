import type { Logger } from "pino";

import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

export async function recoverCrashInterruptedAgents(input: {
  records: readonly StoredAgentRecord[];
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): Promise<void> {
  const interrupted = input.records.filter(
    (record) =>
      record.provider === "codex" &&
      record.lastStatus === "running" &&
      !record.archivedAt &&
      record.persistence?.provider === "codex" &&
      record.persistence.sessionId.trim().length > 0,
  );

  if (interrupted.length === 0) return;

  input.logger.info(
    { agentCount: interrupted.length },
    "Recovering crash-interrupted Codex agents",
  );
  for (const record of interrupted) {
    try {
      await ensureAgentLoaded(record.id, {
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        logger: input.logger,
      });
      input.logger.info({ agentId: record.id }, "Crash-interrupted Codex agent recovered");
    } catch (error) {
      input.logger.warn(
        { err: error, agentId: record.id },
        "Failed to recover crash-interrupted Codex agent",
      );
    }
  }
}
