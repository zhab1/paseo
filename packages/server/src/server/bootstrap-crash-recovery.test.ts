import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { expect, test } from "vitest";

import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentClient, AgentSession } from "./agent/agent-sdk-types.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

function storedAgentRecord(
  id: string,
  cwd: string,
  provider: string,
  lastStatus: StoredAgentRecord["lastStatus"],
  overrides: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  const timestamp = "2026-09-01T00:00:00.000Z";
  return {
    id,
    provider,
    cwd,
    createdAt: timestamp,
    updatedAt: timestamp,
    labels: {},
    lastStatus,
    config: null,
    persistence: { provider, sessionId: id },
    lastError: null,
    archivedAt: null,
    ...overrides,
  };
}

test("recovers only crash-interrupted Codex agents without a client connection", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-crash-recovery-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-crash-agent-"));
  await mkdir(paseoHome, { recursive: true });

  const resumableId = "00000000-0000-4000-8000-000000000401";
  const failedId = "00000000-0000-4000-8000-000000000402";
  const records: StoredAgentRecord[] = [
    storedAgentRecord(resumableId, agentCwd, "codex", "running"),
    storedAgentRecord(failedId, agentCwd, "codex", "running"),
    storedAgentRecord("00000000-0000-4000-8000-000000000403", agentCwd, "codex", "idle"),
    storedAgentRecord("00000000-0000-4000-8000-000000000407", agentCwd, "codex", "closed"),
    storedAgentRecord("00000000-0000-4000-8000-000000000408", agentCwd, "codex", "error"),
    storedAgentRecord("00000000-0000-4000-8000-000000000404", agentCwd, "codex", "running", {
      archivedAt: "2026-09-01T00:00:00.000Z",
    }),
    storedAgentRecord("00000000-0000-4000-8000-000000000405", agentCwd, "claude", "running"),
    storedAgentRecord("00000000-0000-4000-8000-000000000406", agentCwd, "codex", "running", {
      persistence: null,
    }),
  ];
  const storage = new AgentStorage(path.join(paseoHome, "agents"), pino({ level: "silent" }));
  await Promise.all(records.map((record) => storage.upsert(record)));
  await storage.flush();

  const clients = createTestAgentClients();
  const baseCodex = clients.codex;
  if (!baseCodex) throw new Error("Expected fake Codex client");
  let releaseResume!: () => void;
  let announceResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const resumeStarted = new Promise<void>((resolve) => {
    announceResume = resolve;
  });
  const attemptedSessions: string[] = [];
  const codexClient: AgentClient = {
    provider: baseCodex.provider,
    capabilities: baseCodex.capabilities,
    createSession: (...args) => baseCodex.createSession(...args),
    resumeSession: async (...args): Promise<AgentSession> => {
      const [handle] = args;
      attemptedSessions.push(handle.sessionId);
      if (handle.sessionId === failedId) throw new Error("expected recovery failure");
      announceResume();
      await resumeGate;
      return baseCodex.resumeSession(...args);
    },
    fetchCatalog: (...args) => baseCodex.fetchCatalog(...args),
    isAvailable: (...args) => baseCodex.isAvailable(...args),
  };

  const daemonHandle = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    agentClients: { ...clients, codex: codexClient },
  });
  try {
    await resumeStarted;
    const health = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
    expect(health.ok).toBe(true);
    expect(daemonHandle.daemon.agentManager.getAgent(resumableId)).toBeNull();

    releaseResume();
    await expect
      .poll(() => daemonHandle.daemon.agentManager.getAgent(resumableId)?.id)
      .toBe(resumableId);
    await expect.poll(() => attemptedSessions.length).toBe(2);
    expect(new Set(attemptedSessions)).toEqual(new Set([resumableId, failedId]));
  } finally {
    releaseResume();
    await daemonHandle.close();
    await Promise.all([
      rm(paseoHomeRoot, { recursive: true, force: true }),
      rm(agentCwd, { recursive: true, force: true }),
      rm(daemonHandle.staticDir, { recursive: true, force: true }),
    ]);
  }
});
