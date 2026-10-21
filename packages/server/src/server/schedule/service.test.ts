import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent/agent-storage.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import { toAgentPayload, buildStoredAgentPayload } from "../agent/agent-projections.js";
import { createAgentCommand } from "../agent/create-agent/create.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { resolveWorkspaceIdForPath } from "../resolve-workspace-id-for-path.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import {
  type PersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { archiveByScope, type ActiveWorkspaceRef } from "../workspace-archive-service.js";
import {
  ScheduleService,
  ScheduleTargetGoneError,
  type ScheduleServiceOptions,
} from "./service.js";
import { ScheduleStore } from "./store.js";
import type { ScheduleExecutionResult, StoredSchedule } from "@getpaseo/protocol/schedule/types";

interface ScheduleServiceInternals {
  executeSchedule(schedule: StoredSchedule, runId: string): Promise<ScheduleExecutionResult>;
}

class OverlappingTickRunner {
  private resolveFirstRunStarted: () => void = () => {};
  private resolveFirstRunBlocked: () => void = () => {};
  private laterScheduleRunCount = 0;

  readonly firstRunStarted = new Promise<void>((resolve) => {
    this.resolveFirstRunStarted = resolve;
  });
  private readonly firstRunBlocked = new Promise<void>((resolve) => {
    this.resolveFirstRunBlocked = resolve;
  });

  async run(schedule: StoredSchedule): Promise<ScheduleExecutionResult> {
    if (schedule.prompt === "block the first tick") {
      this.resolveFirstRunStarted();
      await this.firstRunBlocked;
    } else {
      this.laterScheduleRunCount += 1;
    }
    return { agentId: null, output: "ok" };
  }

  unblockFirstRun(): void {
    this.resolveFirstRunBlocked();
  }

  get laterScheduleRuns(): number {
    return this.laterScheduleRunCount;
  }
}

const SCHEDULE_TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

const NO_UNATTENDED_SCHEDULE_POLICY: Pick<ProviderSnapshotManager, "resolveCreateConfig"> = {
  async resolveCreateConfig(input) {
    return {
      modeId: input.unattended ? input.requestedMode : "interactive",
      featureValues: input.featureValues,
    };
  },
};

const TEST_CLAUDE_PROVIDER_DEFINITION = {
  enabled: true,
};

let workspaceArchiveInProgress = false;

type TestScheduleServiceOptions = Omit<
  ScheduleServiceOptions,
  "createAgent" | "createDirectoryWorkspace" | "createPaseoWorktreeWorkspace" | "archiveWorkspace"
> & {
  agentManager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createAgent?: ScheduleServiceOptions["createAgent"];
  createDirectoryWorkspace?: ScheduleServiceOptions["createDirectoryWorkspace"];
  createPaseoWorktreeWorkspace?: ScheduleServiceOptions["createPaseoWorktreeWorkspace"];
  archiveWorkspace?: ScheduleServiceOptions["archiveWorkspace"];
};

function createScheduleService(options: TestScheduleServiceOptions): ScheduleService {
  let workspaceCounter = 0;
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const workspaceGitService = createNoopWorkspaceGitService();
  const createDefaultWorkspace: ScheduleServiceOptions["createDirectoryWorkspace"] = async (
    input,
  ) => {
    const timestamp = new Date().toISOString();
    const workspaceId = `wks_schedule_test_${++workspaceCounter}`;
    const workspace: PersistedWorkspaceRecord = {
      workspaceId,
      projectId: "test-project",
      cwd: input.cwd,
      kind: "directory",
      displayName: "test-project",
      title: input.firstAgentContext.prompt,
      branch: null,
      baseBranch: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
    workspaces.set(workspaceId, workspace);
    return workspace;
  };
  const listActiveWorkspaces = async (): Promise<ActiveWorkspaceRef[]> =>
    Array.from(workspaces.values())
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
      }));
  const archiveDefaultWorkspace: ScheduleServiceOptions["archiveWorkspace"] = async (
    workspaceId,
  ) => {
    workspaceArchiveInProgress = true;
    try {
      await archiveByScope(
        {
          github: { invalidate: () => {} } as never,
          workspaceGitService,
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          findWorkspaceIdForCwd: async (cwd) =>
            Array.from(workspaces.values()).find((workspace) => workspace.cwd === cwd)
              ?.workspaceId ?? null,
          listActiveWorkspaces,
          archiveWorkspaceRecord: async (id) => {
            const workspace = workspaces.get(id);
            if (workspace) {
              workspaces.set(id, { ...workspace, archivedAt: new Date().toISOString() });
            }
          },
          emitWorkspaceUpdatesForWorkspaceIds: async () => {},
          markWorkspaceArchiving: () => {},
          clearWorkspaceArchiving: () => {},
          killTerminalsForWorkspace: async () => {},
          sessionLogger: options.logger,
        },
        {
          scope: { kind: "workspace", workspaceId },
          requestId: "schedule-service-test",
        },
      );
    } finally {
      workspaceArchiveInProgress = false;
    }
  };
  return new ScheduleService({
    ...options,
    createAgent:
      options.createAgent ??
      ((input) =>
        createAgentCommand(
          {
            agentManager: options.agentManager,
            agentStorage: options.agentStorage,
            logger: options.logger,
            providerSnapshotManager: options.providerSnapshotManager as ProviderSnapshotManager,
          },
          input,
        )),
    createDirectoryWorkspace: options.createDirectoryWorkspace ?? createDefaultWorkspace,
    createPaseoWorktreeWorkspace:
      options.createPaseoWorktreeWorkspace ??
      (async (input) => {
        const workspace = await createDefaultWorkspace(input);
        return {
          workspace,
          worktree: { branchName: "schedule-test", worktreePath: workspace.cwd },
          intent: { kind: "branch-off", baseBranch: "main", branchName: "schedule-test" },
          repoRoot: workspace.cwd,
          created: true,
        };
      }),
    archiveWorkspace: options.archiveWorkspace ?? archiveDefaultWorkspace,
  });
}

async function createRegistryBackedScheduleWorkspaceDeps(rootDir: string): Promise<{
  workspaceRegistry: FileBackedWorkspaceRegistry;
  createDirectoryWorkspace: ScheduleServiceOptions["createDirectoryWorkspace"];
  createArchiveWorkspace: (input: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger?: ScheduleServiceOptions["logger"];
  }) => ScheduleServiceOptions["archiveWorkspace"];
}> {
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    join(rootDir, "projects", "workspaces.json"),
    createTestLogger(),
  );
  const projectRegistry = new FileBackedProjectRegistry(
    join(rootDir, "projects", "projects.json"),
    createTestLogger(),
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  const workspaceGitService = createNoopWorkspaceGitService();
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async () => true,
  });
  return {
    workspaceRegistry,
    createDirectoryWorkspace: async (input) => {
      return workspaceProvisioning.createWorkspaceForDirectory(
        input.cwd,
        input.firstAgentContext.prompt,
      );
    },
    createArchiveWorkspace:
      ({ agentManager, agentStorage, logger = createTestLogger() }) =>
      async (workspaceId) => {
        workspaceArchiveInProgress = true;
        try {
          await archiveByScope(
            {
              github: { invalidate: () => {} } as never,
              workspaceGitService,
              agentManager,
              agentStorage,
              findWorkspaceIdForCwd: async (cwd) =>
                resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list()),
              listActiveWorkspaces: async () =>
                (await workspaceRegistry.list())
                  .filter((workspace) => !workspace.archivedAt)
                  .map((workspace) => ({
                    workspaceId: workspace.workspaceId,
                    cwd: workspace.cwd,
                    kind: workspace.kind,
                  })),
              archiveWorkspaceRecord: async (id) => {
                await workspaceRegistry.archive(id, new Date().toISOString());
              },
              emitWorkspaceUpdatesForWorkspaceIds: async () => {},
              markWorkspaceArchiving: () => {},
              clearWorkspaceArchiving: () => {},
              killTerminalsForWorkspace: async () => {},
              sessionLogger: logger,
            },
            {
              scope: { kind: "workspace", workspaceId },
              requestId: "schedule-service-test",
            },
          );
        } finally {
          workspaceArchiveInProgress = false;
        }
      },
  };
}

function buildAgentRecord(params: {
  id: string;
  cwd: string;
  iso: string;
  archivedAt?: string | null;
}) {
  return {
    id: params.id,
    provider: "claude",
    cwd: params.cwd,
    createdAt: params.iso,
    updatedAt: params.iso,
    lastActivityAt: params.iso,
    lastUserMessageAt: null,
    title: params.id,
    labels: {},
    lastStatus: "closed" as const,
    lastModeId: "default",
    config: { modeId: "default" },
    runtimeInfo: null,
    features: [],
    persistence: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: params.archivedAt ?? null,
  };
}

describe("ScheduleService", () => {
  let tempDir: string;
  let agentStorage: AgentStorage;
  let now: Date;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-service-test-"));
    await mkdir(join(tempDir, "agents"), { recursive: true });
    agentStorage = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await agentStorage.initialize();
    now = new Date("2026-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    // Drain pending background persists before deleting the dir to avoid
    // ENOTEMPTY races when AgentManager flushes a snapshot mid-cleanup.
    await agentStorage.flush();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("ticks due schedules and records run history on disk", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000001",
        output: `ran:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "Review new PRs",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000001",
      output: "ran:Review new PRs",
    });
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  async function quotaFixture(runner?: ScheduleServiceOptions["runner"]) {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const agent = await manager.createAgent(
      { provider: "claude", cwd: tempDir, modeId: "bypassPermissions" },
      undefined,
      { workspaceId: undefined },
    );
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      ...(runner ? { runner } : {}),
    });
    manager.setQuotaContinuationHooks({
      cancel: (id) => service.cancelQuotaContinuation(id),
      stopped: (id, event, at) => service.handleQuotaStop(id, event, at),
    });
    const input = {
      agentId: agent.id,
      turnId: "limited-turn",
      lastUserMessageAt: null,
      resetsAt: now.getTime() / 1000 + 60,
    };
    return { manager, service, input };
  }

  async function runToQuota(fixture: Awaited<ReturnType<typeof quotaFixture>>) {
    const { manager, input } = fixture;
    const session = manager.getAgent(input.agentId)!.session! as unknown as {
      notifySubscribers(event: AgentStreamEvent): void;
    };
    const emit = session.notifySubscribers.bind(session);
    const quota = vi
      .spyOn(session, "notifySubscribers")
      .mockImplementation((event) =>
        emit(
          event.type === "turn_failed"
            ? { ...event, subscriptionLimit: { type: "five_hour", resetsAt: input.resetsAt } }
            : event,
        ),
      );
    await expect(
      manager.runAgent(input.agentId, "Emit a turn failure", {
        clientMessageId: "quota-client",
      }),
    ).rejects.toThrow();
    quota.mockRestore();
    return emit;
  }

  async function stopForQuota(
    fixture: Awaited<ReturnType<typeof quotaFixture>>,
    expectPending = true,
  ) {
    const { manager, input } = fixture;
    const emit = await runToQuota(fixture);
    await manager.flush();
    expect(manager.getAgent(input.agentId)?.lifecycle).toBe("error");
    expect(manager.getAgent(input.agentId)?.attention.requiresAttention).toBe(!expectPending);
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    const job = (await store.list()).find((s) => s.quotaContinuation && s.status === "active");
    if (expectPending) expect(job?.target).toEqual({ type: "agent", agentId: input.agentId });
    else expect(job).toBeUndefined();
    return { job: job!, emit };
  }

  test("five-hour jobs deduplicate, stay private, and catch up after an offline reset", async () => {
    const run = vi.fn(async () => ({ agentId: null, output: "delivered" }));
    const { service, input } = await quotaFixture(run);
    const [first, duplicate] = await Promise.all([
      service.armQuotaContinuation(input),
      service.armQuotaContinuation(input),
    ]);
    expect(first?.id).toBe(duplicate?.id);
    expect(await service.list()).toEqual([]);
    await service.tick();
    expect(run).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 120_000);
    await service.start();
    await service.stop();
    await Promise.all([service.tick(), service.tick()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await service.inspect(first!.id)).status).toBe("completed");
    await service.armQuotaContinuation(input);
    await service.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each(["claude", "codex"])(
    "ordinary %s prompts do not read unrelated quota storage",
    async (provider) => {
      const { manager, input } = await quotaFixture();
      const agentId =
        provider === "claude"
          ? input.agentId
          : (
              await manager.createAgent({ provider, cwd: tempDir }, undefined, {
                workspaceId: undefined,
              })
            ).id;
      const reads = vi
        .spyOn(ScheduleStore.prototype, "list")
        .mockRejectedValue(new Error("Unrelated schedule read failed"));
      await startAgentRun(manager, agentId, "Ordinary task", createTestLogger());
      await manager.waitForAgentEvent(agentId, { waitForActive: true });
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
    },
  );

  test("Stop queued during arming cancels the newly persisted job", async () => {
    const run = vi.fn(async () => ({ agentId: null, output: "unexpected" }));
    const { manager, service, input } = await quotaFixture(run);
    let entered!: () => void;
    let release!: () => void;
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = ScheduleStore.prototype.create;
    const write = vi
      .spyOn(ScheduleStore.prototype, "create")
      .mockImplementation(async function (record) {
        entered();
        await blocked;
        return create.call(this, record);
      });
    const arming = service.armQuotaContinuation(input);
    await creating;
    const stop = manager.cancelAgentRun(input.agentId);
    release();
    const job = await arming;
    await stop;
    write.mockRestore();
    expect(await service.inspect(job!.id)).toMatchObject({
      status: "completed",
      quotaContinuation: { cancelled: true },
    });
    now = new Date(now.getTime() + 120_000);
    await service.tick();
    expect(run).not.toHaveBeenCalled();
  });

  test("delivered quota ownership remains cancellable before a repeated quota event", async () => {
    const { manager, service, input } = await quotaFixture();
    const job = await service.armQuotaContinuation(input);
    now = new Date(now.getTime() + 120_000);
    await service.tick();
    await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
    const delivered = await service.inspect(job!.id);
    await service.cancelQuotaContinuation(input.agentId);
    expect(await service.inspect(job!.id)).toMatchObject({
      quotaContinuation: { cancelled: true },
    });
    expect(
      await service.armQuotaContinuation({
        ...input,
        turnId: delivered.quotaContinuation!.deliveredTurnId!,
        lastUserMessageAt:
          manager.getAgent(input.agentId)?.lastUserMessageAt?.toISOString() ?? null,
      }),
    ).toBeNull();
  });

  test("an interrupted continuation claim is not blindly resent on restart", async () => {
    const run = vi.fn(async () => ({ agentId: null, output: "delivered" }));
    const { service, input } = await quotaFixture(run);
    const job = await service.armQuotaContinuation(input);
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    await store.update(job!.id, (s) => ({
      ...s,
      nextRunAt: null,
      runs: [
        {
          id: "claimed-before-crash",
          scheduledFor: s.nextRunAt!,
          startedAt: now.toISOString(),
          endedAt: null,
          status: "running",
          agentId: input.agentId,
          output: null,
          error: null,
        },
      ],
    }));
    now = new Date(now.getTime() + 120_000);
    await service.start();
    await service.stop();
    await service.tick();
    expect(run).not.toHaveBeenCalled();
    expect((await service.inspect(job!.id)).status).toBe("completed");
    expect((await service.inspect(job!.id)).runs[0].error).toContain("Daemon restarted");
  });

  test.each(["Stop", "prompt", "weekly", "archive"])(
    "%s cancels the pending same-chat continuation",
    async (action) => {
      const run = vi.fn(async () => ({ agentId: null, output: "delivered" }));
      const { service, manager, input } = await quotaFixture(run);
      const job = await service.armQuotaContinuation(input);
      if (action === "Stop") await manager.cancelAgentRun(input.agentId);
      if (action === "prompt") await manager.runAgent(input.agentId, "A new request");
      if (action === "weekly")
        await service.handleQuotaStop(
          input.agentId,
          {
            type: "turn_failed",
            provider: "claude",
            turnId: "weekly-turn",
            error: "quota",
            subscriptionLimit: { type: "weekly" },
          },
          null,
        );
      if (action === "archive") await manager.archiveAgent(input.agentId);
      now = new Date(now.getTime() + 120_000);
      await service.tick();
      expect(run).not.toHaveBeenCalled();
      expect((await service.inspect(job!.id)).status).toBe("completed");
    },
  );

  test("same-agent continuation starts once and records its accepted turn identity", async () => {
    const { service, input } = await quotaFixture();
    const job = await service.armQuotaContinuation(input);
    now = new Date(now.getTime() + 120_000);
    await Promise.all([service.tick(), service.tick()]);
    const stored = await service.inspect(job!.id);
    expect(stored.runs).toHaveLength(1);
    expect(stored.runs[0].status).toBe("succeeded");
    expect(stored.quotaContinuation?.deliveredTurnId).toEqual(expect.any(String));
    expect(stored.runs[0].output).toBe("Continuation delivered");
  });

  test("transcript-only autonomous turns preserve the pending quota continuation", async () => {
    const fixture = await quotaFixture();
    const { manager, service, input } = fixture;
    const { job, emit } = await stopForQuota(fixture);
    const lastUserMessageAt = manager.getAgent(input.agentId)!.lastUserMessageAt;
    emit({ type: "turn_started", provider: "claude", turnId: "another-refusal" });
    emit({
      type: "timeline",
      provider: "claude",
      turnId: "another-refusal",
      item: { type: "assistant_message", text: "Session limit reached." },
    });
    emit({
      type: "turn_failed",
      provider: "claude",
      turnId: "another-refusal",
      error: "Session limit reached",
    });
    await manager.flush();
    for (const turnId of ["worker-notification-1", "worker-notification-2"]) {
      emit({ type: "turn_started", provider: "claude", turnId });
      emit({
        type: "timeline",
        provider: "claude",
        turnId,
        item: {
          type: "tool_call",
          callId: turnId,
          name: "task_notification",
          status: "failed",
          error: { message: "Background worker stopped." },
          detail: { type: "plain_text", text: "Background worker stopped." },
          metadata: { synthetic: true, source: "claude_task_notification" },
        },
      });
      emit({ type: "turn_completed", provider: "claude", turnId });
      await manager.flush();
      expect(await service.inspect(job.id)).toMatchObject({
        status: "active",
        nextRunAt: job.nextRunAt,
        runs: [],
      });
      expect(manager.getAgent(input.agentId)!.lastUserMessageAt).toEqual(lastUserMessageAt);
      expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("running");
    }
    now = new Date(now.getTime() + 120_000);
    await service.tick();
    await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
    const stored = await service.inspect(job.id);
    expect(stored.runs).toHaveLength(1);
    expect(stored.runs[0].output).toBe("Continuation delivered");
    expect(stored.quotaContinuation?.deliveredTurnId).toEqual(expect.any(String));
    await service.tick();
    expect((await service.inspect(job.id)).runs).toHaveLength(1);
  });

  test.each([
    { type: "assistant_message", text: "Completed the interrupted task." },
    { type: "reasoning", text: "The requested work is complete." },
    {
      type: "tool_call",
      callId: "main-tool",
      name: "Bash",
      status: "running",
      error: null,
      detail: { type: "shell", command: "finish-task" },
    },
  ] satisfies AgentTimelineItem[])(
    "successful autonomous $type output supersedes the quota continuation",
    async (item) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      const { job, emit } = await stopForQuota(fixture);
      const turnId = "autonomous-resumed-work";
      emit({ type: "turn_started", provider: "claude", turnId });
      emit({
        type: "timeline",
        provider: "claude",
        turnId,
        item,
      });
      emit({ type: "turn_completed", provider: "claude", turnId });
      await manager.flush();
      expect(await service.inspect(job.id)).toMatchObject({
        status: "completed",
        quotaContinuation: { cancelled: true },
        runs: [],
      });
      now = new Date(now.getTime() + 120_000);
      await service.tick();
      expect((await service.inspect(job.id)).runs).toEqual([]);
      expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("idle");
    },
  );

  test.each(["pause", "resume", "update", "delete", "runOnce"] as const)(
    "public %s cannot mutate a private quota job or send before reset",
    async (action) => {
      const fixture = await quotaFixture();
      const { service, manager, input } = fixture;
      const { job } = await stopForQuota(fixture);
      const start = vi.spyOn(manager.getAgent(input.agentId)!.session!, "startTurn");
      const mutation =
        action === "update"
          ? service.update({ id: job.id, prompt: "Send early" })
          : service[action](job.id);
      await expect(mutation).rejects.toThrow();
      expect(await service.inspect(job.id)).toEqual(job);
      expect(await service.logs(job.id)).toEqual([]);
      expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("running");
      expect(start).not.toHaveBeenCalled();
      await manager.cancelAgentRun(input.agentId);
      await manager.flush();
    },
  );

  test.each(["archive", "cascade", "complete", "delete"])(
    "stored-only %s clears durable quota ownership and restored presentation",
    async (action) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      const { job } = await stopForQuota(fixture);
      await service.stop();
      await manager.closeAgent(input.agentId);
      await manager.flush();
      const freshManager = new AgentManager({
        logger: createTestLogger(),
        clients: createTestAgentClients(),
        registry: agentStorage,
      });
      const freshService = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: freshManager,
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
      });
      freshManager.setQuotaContinuationHooks({
        cancel: (id) => freshService.cancelQuotaContinuation(id),
        stopped: (id, event, at) => freshService.handleQuotaStop(id, event, at),
      });
      freshManager.setAgentArchivedCallback(async (id) => {
        await freshService.completeForAgent(id);
      });
      await freshService.start();
      expect(freshManager.getAgent(input.agentId)).toBeNull();
      expect(
        buildStoredAgentPayload((await agentStorage.get(input.agentId))!, ["claude"]).status,
      ).toBe("running");
      if (action === "cascade") {
        const parent = await freshManager.createAgent(
          { provider: "codex", cwd: tempDir },
          undefined,
          { workspaceId: undefined },
        );
        const child = (await agentStorage.get(input.agentId))!;
        await agentStorage.upsert({
          ...child,
          labels: { ...child.labels, [PARENT_AGENT_ID_LABEL]: parent.id },
        });
        await freshManager.archiveAgent(parent.id);
        await freshManager.unarchiveSnapshot(input.agentId);
      } else if (action === "archive") {
        await freshManager.archiveSnapshot(input.agentId, now.toISOString());
        await freshManager.unarchiveSnapshot(input.agentId);
      } else if (action === "delete") {
        await agentStorage.remove(input.agentId);
        await freshManager.deleteAgentState(input.agentId);
      } else await freshService.completeForAgent(input.agentId);
      await freshManager.flush();
      expect(await freshService.inspect(job.id)).toMatchObject({
        status: "completed",
        quotaContinuation: { cancelled: true },
      });
      const restored = await agentStorage.get(input.agentId);
      if (action === "delete") expect(restored).toBeNull();
      else expect(buildStoredAgentPayload(restored!, ["claude"]).status).not.toBe("running");
      now = new Date(now.getTime() + 120_000);
      await freshService.tick();
      expect((await freshService.inspect(job.id)).runs).toEqual([]);
      await freshService.stop();
      for (const agent of freshManager.listAgents()) await freshManager.closeAgent(agent.id);
      await freshManager.flush();
    },
  );

  test.each(["weekly", "Stop", "Stop then weekly"])(
    "%s ending a real quota wait publishes error attention only for the weekly cancellation",
    async (action) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      const { job, emit } = await stopForQuota(fixture);
      const attention = vi.fn();
      manager.setAgentAttentionCallback(attention);
      let stop: Promise<unknown> | undefined;
      let release: (() => void) | undefined;
      let save: ReturnType<typeof vi.spyOn> | undefined;
      if (action === "Stop then weekly") {
        let entered!: () => void;
        const cancelling = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const list = ScheduleStore.prototype.list;
        save = vi.spyOn(ScheduleStore.prototype, "list").mockImplementationOnce(async function () {
          entered();
          await blocked;
          return list.call(this);
        });
        stop = manager.cancelAgentRun(input.agentId);
        await cancelling;
      } else if (action === "Stop") await manager.cancelAgentRun(input.agentId);
      if (action !== "Stop") {
        emit({ type: "subscription_blocked", provider: "claude" });
        release?.();
        await stop;
        await manager.flush();
        emit({ type: "subscription_blocked", provider: "claude" });
      }
      await manager.flush();
      save?.mockRestore();
      expect(await service.inspect(job.id)).toMatchObject({
        status: "completed",
        quotaContinuation: { cancelled: true },
      });
      expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("error");
      expect(attention).toHaveBeenCalledTimes(action === "weekly" ? 1 : 0);
      if (action === "weekly") {
        expect(attention).toHaveBeenCalledWith(expect.objectContaining({ reason: "error" }));
        expect((await agentStorage.get(input.agentId))?.requiresAttention).toBe(true);
      }
    },
  );

  test("failed quota arming retains actionable terminal error attention", async () => {
    const fixture = await quotaFixture();
    const attention = vi.fn();
    fixture.manager.setAgentAttentionCallback(attention);
    vi.spyOn(fixture.service, "armQuotaContinuation").mockRejectedValueOnce(
      new Error("Store failed"),
    );
    await stopForQuota(fixture, false);
    expect(toAgentPayload(fixture.manager.getAgent(fixture.input.agentId)!).status).toBe("error");
    expect(attention).toHaveBeenCalledTimes(1);
    expect(attention).toHaveBeenCalledWith(expect.objectContaining({ reason: "error" }));
  });

  test.each(["Stop", "prompt", "weekly"])(
    "%s during ownership persistence prevents stale quota arming",
    async (action) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      let entered!: () => void;
      let release!: () => void;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const snapshot = agentStorage.applySnapshot.bind(agentStorage);
      vi.spyOn(agentStorage, "applySnapshot").mockImplementation(async (agent, options) => {
        if (agent.lifecycle === "error") {
          entered();
          await blocked;
        }
        return snapshot(agent, options);
      });
      const stopped = runToQuota(fixture);
      await saving;
      const arm = vi.spyOn(service, "armQuotaContinuation");
      let mutation: Promise<unknown> | undefined;
      if (action === "Stop") mutation = manager.cancelAgentRun(input.agentId);
      if (action === "prompt") mutation = manager.runAgent(input.agentId, "Following user task");
      if (action === "weekly") {
        (
          manager.getAgent(input.agentId)!.session! as unknown as {
            notifySubscribers(event: AgentStreamEvent): void;
          }
        ).notifySubscribers({ type: "subscription_blocked", provider: "claude" });
      }
      release();
      await stopped;
      await mutation;
      await manager.flush();
      expect(arm).not.toHaveBeenCalled();
      expect(
        (await new ScheduleStore(join(tempDir, "schedules"), createTestLogger()).list()).filter(
          (s) => s.status === "active",
        ),
      ).toEqual([]);
      expect(toAgentPayload(manager.getAgent(input.agentId)!).status).not.toBe("running");
      await service.stop();
    },
  );

  test("failed ownership persistence leaves an actionable error without a quota job", async () => {
    const fixture = await quotaFixture();
    const snapshot = agentStorage.applySnapshot.bind(agentStorage);
    let failed = false;
    vi.spyOn(agentStorage, "applySnapshot").mockImplementation((agent, options) => {
      if (agent.lifecycle === "error" && !failed) {
        failed = true;
        return Promise.reject(new Error("Snapshot unavailable"));
      }
      return snapshot(agent, options);
    });
    await stopForQuota(fixture, false);
    expect((await agentStorage.get(fixture.input.agentId))?.attentionReason).toBe("error");
  });

  test.each(["conversation", "files", "both"] as const)(
    "successful %s rewind cancels quota continuation even during its claim",
    async (mode) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      const { job } = await stopForQuota(fixture);
      const session = manager.getAgent(input.agentId)!.session!;
      const revert = vi.fn(async () => {});
      Object.assign(session, {
        capabilities: {
          ...session.capabilities,
          supportsRewindConversation: true,
          supportsRewindFiles: true,
          supportsRewindBoth: true,
        },
        revertConversation: revert,
        revertFiles: revert,
        revertBoth: revert,
      });
      let entered!: () => void;
      let release!: () => void;
      const claiming = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admit = manager.continueQuotaStoppedAgent.bind(manager);
      async function gatedClaim(claim: () => Promise<boolean>) {
        entered();
        await blocked;
        return claim();
      }
      vi.spyOn(manager, "continueQuotaStoppedAgent").mockImplementation((id, at, claim, started) =>
        admit(id, at, gatedClaim.bind(null, claim), started),
      );
      const start = vi.spyOn(session, "startTurn");
      now = new Date(now.getTime() + 120_000);
      const tick = service.tick();
      await claiming;
      const rewind = manager.rewind(input.agentId, "provider-message", mode);
      release();
      await Promise.all([tick, rewind]);
      await manager.flush();
      expect(revert).toHaveBeenCalledExactlyOnceWith({ messageId: "provider-message" });
      expect(start).not.toHaveBeenCalled();
      expect(await service.inspect(job.id)).toMatchObject({
        status: "completed",
        quotaContinuation: { cancelled: true },
      });
      expect(toAgentPayload(manager.getAgent(input.agentId)!).status).not.toBe("running");
    },
  );

  test.each(["unsupported", "failed"])(
    "%s rewind preserves unsupported work or cancels supported intent without a stranded lock",
    async (outcome) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      const { job } = await stopForQuota(fixture);
      const session = manager.getAgent(input.agentId)!.session!;
      if (outcome === "failed")
        Object.assign(session, {
          capabilities: { ...session.capabilities, supportsRewindFiles: true },
          revertFiles: async () => {
            throw new Error("Rewind failed");
          },
        });
      await expect(manager.rewind(input.agentId, "provider-message", "files")).rejects.toThrow();
      expect((await service.inspect(job.id)).status).toBe(
        outcome === "failed" ? "completed" : "active",
      );
      expect((await service.inspect(job.id)).quotaContinuation?.cancelled).toBe(
        outcome === "failed" ? true : undefined,
      );
      expect(manager.hasInFlightRun(input.agentId)).toBe(false);
      now = new Date(now.getTime() + 120_000);
      await service.tick();
      expect((await service.inspect(job.id)).runs.map((run) => run.output)).toEqual(
        outcome === "failed" ? [] : ["Continuation delivered"],
      );
      await manager.flush();
    },
  );

  test("the repeated-quota ceiling leaves an actionable terminal error without another job", async () => {
    const fixture = await quotaFixture();
    const { manager, service, input } = fixture;
    const { emit } = await stopForQuota(fixture);
    const attention = vi.fn();
    manager.setAgentAttentionCallback(attention);
    const start = vi.spyOn(manager.getAgent(input.agentId)!.session!, "startTurn");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const turnId = `continued-${attempt}`;
      start.mockResolvedValueOnce({ turnId });
      now = new Date(now.getTime() + 120_000);
      await service.tick();
      emit({
        type: "turn_failed",
        provider: "claude",
        turnId,
        error: "quota",
        subscriptionLimit: { type: "five_hour", resetsAt: now.getTime() / 1000 + 60 },
      });
      await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
      await manager.flush();
      expect(attention).toHaveBeenCalledTimes(attempt === 3 ? 1 : 0);
    }
    expect(start).toHaveBeenCalledTimes(3);
    expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("error");
    expect(
      (await new ScheduleStore(join(tempDir, "schedules"), createTestLogger()).list()).filter(
        (schedule) => schedule.status === "active",
      ),
    ).toEqual([]);
  });

  test.each(["success", "failed", "rejected"])(
    "a fast %s continuation preserves its finished/error notification",
    async (outcome) => {
      const fixture = await quotaFixture();
      const { service, manager, input } = fixture;
      await stopForQuota(fixture);
      const attention = vi.fn();
      manager.setAgentAttentionCallback(attention);
      const session = manager.getAgent(input.agentId)!.session!;
      if (outcome === "failed") {
        const start = session.startTurn.bind(session);
        vi.spyOn(session, "startTurn").mockImplementation((_prompt, options) =>
          start("Emit a turn failure", options),
        );
      }
      if (outcome === "rejected")
        vi.spyOn(session, "startTurn").mockRejectedValueOnce(
          new Error("Transport rejected continuation"),
        );
      const admit = manager.continueQuotaStoppedAgent.bind(manager);
      vi.spyOn(manager, "continueQuotaStoppedAgent").mockImplementation(async (...args) => {
        const accepted = await admit(...args);
        await manager.waitForAgentEvent(args[0], { waitForActive: true });
        return accepted;
      });
      now = new Date(now.getTime() + 120_000);
      await service.tick();
      await manager.flush();
      expect(attention).toHaveBeenCalledTimes(1);
      expect(attention).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: outcome === "success" ? "finished" : "error",
        }),
      );
      expect(manager.getAgent(input.agentId)?.attention.requiresAttention).toBe(true);
    },
  );

  test.each(["active", "completed", "cancelled", "rearmed"])(
    "a stale tick snapshot preserves %s quota presentation",
    async (phase) => {
      const fixture = await quotaFixture();
      const { service, manager, input } = fixture;
      const { job, emit } = await stopForQuota(fixture);
      const stale = [await service.inspect(job.id)];
      const attention = vi.fn();
      manager.setAgentAttentionCallback(attention);
      const start = vi
        .spyOn(manager.getAgent(input.agentId)!.session!, "startTurn")
        .mockResolvedValueOnce({ turnId: "continued" });
      now = new Date(now.getTime() + 120_000);
      if (phase === "cancelled") await service.cancelQuotaContinuation(input.agentId);
      else {
        await service.tick();
        expect(manager.hasInFlightRun(input.agentId)).toBe(true);
        if (phase === "rearmed")
          emit({
            type: "turn_failed",
            provider: "claude",
            turnId: "continued",
            error: "quota",
            subscriptionLimit: { type: "five_hour", resetsAt: input.resetsAt + 600 },
          });
        else if (phase === "completed")
          emit({ type: "turn_completed", provider: "claude", turnId: "continued" });
        if (phase !== "active")
          await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
      }
      const read = vi.spyOn(ScheduleStore.prototype, "list").mockResolvedValueOnce(stale);
      await service.tick();
      read.mockRestore();
      if (phase === "active") {
        emit({ type: "turn_completed", provider: "claude", turnId: "continued" });
        await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
      }
      if (phase === "rearmed") {
        expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("running");
        const pending = (
          await new ScheduleStore(join(tempDir, "schedules"), createTestLogger()).list()
        ).filter((s) => s.status === "active");
        expect(pending).toHaveLength(1);
        expect(pending[0].quotaContinuation?.attempt).toBe(1);
      } else {
        expect(toAgentPayload(manager.getAgent(input.agentId)!).status).not.toBe("running");
        if (phase !== "cancelled") {
          expect(attention).toHaveBeenCalledWith(expect.objectContaining({ reason: "finished" }));
          expect(manager.getAgent(input.agentId)?.attention.requiresAttention).toBe(true);
        }
      }
      expect(start).toHaveBeenCalledTimes(phase === "cancelled" ? 0 : 1);
    },
  );

  test("failed accepted-turn persistence retains run ownership and suppresses further automatic sends", async () => {
    const fixture = await quotaFixture();
    const { service, manager, input } = fixture;
    const { job, emit } = await stopForQuota(fixture);
    const session = manager.getAgent(input.agentId)!.session!;
    const start = vi.spyOn(session, "startTurn").mockResolvedValueOnce({ turnId: "accepted-turn" });
    const update = ScheduleStore.prototype.update;
    const rejectIdentityWrite = async (
      updater: Parameters<typeof update>[1],
      record: StoredSchedule,
    ) => {
      const next = await updater(record);
      if (!record.quotaContinuation?.deliveredTurnId && next.quotaContinuation?.deliveredTurnId)
        throw new Error("Atomic identity write failed");
      return next;
    };
    const save = vi
      .spyOn(ScheduleStore.prototype, "update")
      .mockImplementation(function (id, updater) {
        return update.call(this, id, rejectIdentityWrite.bind(null, updater));
      });
    now = new Date(now.getTime() + 120_000);
    await service.tick();
    save.mockRestore();
    expect(manager.hasInFlightRun(input.agentId)).toBe(true);
    expect(manager.getAgent(input.agentId)?.activeForegroundTurnId).toBe("accepted-turn");
    expect(await service.inspect(job.id)).toMatchObject({
      status: "completed",
      quotaContinuation: { cancelled: true },
    });
    emit({
      type: "turn_failed",
      provider: "claude",
      turnId: "accepted-turn",
      error: "quota",
      subscriptionLimit: { type: "five_hour", resetsAt: input.resetsAt + 600 },
    });
    await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
    await service.tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(
      (await new ScheduleStore(join(tempDir, "schedules"), createTestLogger()).list()).filter(
        (s) => s.status === "active",
      ),
    ).toEqual([]);
    await manager.runAgent(input.agentId, "Following user task");
    expect(start).toHaveBeenCalledTimes(2);
  });

  test.each(["failure", "Stop", "archive"])(
    "a cold reload %s preserves durable attention and cancellation during its write",
    async (action) => {
      const fixture = await quotaFixture();
      const { manager, service, input } = fixture;
      const { job } = await stopForQuota(fixture);
      await service.stop();
      await manager.closeAgent(input.agentId);
      await manager.flush();
      const freshManager = new AgentManager({
        logger: createTestLogger(),
        clients: createTestAgentClients(),
        registry: agentStorage,
      });
      const attention = vi.fn();
      freshManager.setAgentAttentionCallback(attention);
      vi.spyOn(freshManager, "resumeAgentFromPersistence").mockRejectedValue(
        new Error("Provider reload failed"),
      );
      const states: string[] = [];
      freshManager.subscribe(
        (event) => {
          if (event.type === "agent_state") states.push(toAgentPayload(event.agent).status);
        },
        { replayState: false, agentId: input.agentId },
      );
      const freshService = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: freshManager,
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
      });
      await freshService.start();
      await freshManager.flush();
      expect(states.at(-1)).toBe("running");
      now = new Date(now.getTime() + 120_000);
      let entered!: () => void;
      let release!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const upsert = agentStorage.upsert.bind(agentStorage);
      vi.spyOn(agentStorage, "upsert").mockImplementation(async (record) => {
        await upsert(record);
        if (record.requiresAttention && record.lastError === "Provider reload failed") {
          entered();
          await blocked;
        }
      });
      freshManager.setQuotaContinuationHooks({
        cancel: (id) => freshService.cancelQuotaContinuation(id),
        stopped: (id, event, at) => freshService.handleQuotaStop(id, event, at),
      });
      const tick = freshService.tick();
      await writing;
      let cancel: Promise<unknown> | undefined;
      if (action === "Stop") cancel = freshManager.cancelAgentRun(input.agentId);
      if (action === "archive")
        cancel = freshManager.archiveSnapshot(input.agentId, now.toISOString());
      release();
      await Promise.all([tick, cancel]);
      await freshManager.flush();
      expect(await freshService.inspect(job.id)).toMatchObject({
        status: "completed",
        runs: [{ status: "failed" }],
      });
      expect(states.at(-1)).not.toBe("running");
      expect(freshManager.getAgent(input.agentId)).toBeNull();
      const reloaded = new AgentStorage(join(tempDir, "agents"), createTestLogger());
      expect(await reloaded.get(input.agentId)).toMatchObject({
        requiresAttention: action === "failure",
        attentionReason: action === "failure" ? "error" : null,
        lastError: "Provider reload failed",
      });
      expect(attention.mock.calls).toEqual(
        action === "failure"
          ? [
              [
                {
                  agentId: input.agentId,
                  provider: "claude",
                  reason: "error",
                },
              ],
            ]
          : [],
      );
      await freshService.stop();
    },
  );

  test("a fresh manager and service recover the persisted job, restore Stop, and deliver to the original agent", async () => {
    const fixture = await quotaFixture();
    const { service, manager, input } = fixture;
    let release!: () => void;
    let terminalQueued!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminalSnapshot = new Promise<void>((resolve) => {
      terminalQueued = resolve;
    });
    const storageWriter = agentStorage as unknown as {
      writeRecord(record: StoredAgentRecord): Promise<void>;
    };
    const write = storageWriter.writeRecord.bind(agentStorage);
    const saving = vi.spyOn(storageWriter, "writeRecord").mockImplementation(async (record) => {
      if (record.lastUserMessageAt) await blocked;
      await write(record);
    });
    const snapshot = agentStorage.applySnapshot.bind(agentStorage);
    vi.spyOn(agentStorage, "applySnapshot").mockImplementation((agent, options) => {
      if (agent.lifecycle === "error") terminalQueued();
      return snapshot(agent, options);
    });
    const stopped = runToQuota(fixture);
    await terminalSnapshot;
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    try {
      expect(await store.list()).toEqual([]);
    } finally {
      release();
    }
    await stopped;
    await manager.flush();
    saving.mockRestore();
    const job = (await store.list())[0];
    expect(job.quotaContinuation?.lastUserMessageAt).toEqual(expect.any(String));
    expect(job.quotaContinuation?.lastUserMessageAt).toBe(
      (await new AgentStorage(join(tempDir, "agents"), createTestLogger()).get(input.agentId))
        ?.lastUserMessageAt,
    );
    await service.stop();
    await manager.closeAgent(input.agentId);
    await manager.flush();
    const reloaded = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await reloaded.initialize();
    const freshManager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: reloaded,
    });
    const freshService = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: freshManager,
      agentStorage: reloaded,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });
    freshManager.setQuotaContinuationHooks({
      cancel: (id) => freshService.cancelQuotaContinuation(id),
      stopped: (id, event, at) => freshService.handleQuotaStop(id, event, at),
    });
    await freshService.start();
    expect(buildStoredAgentPayload((await reloaded.get(input.agentId))!, ["claude"]).status).toBe(
      "running",
    );
    expect(freshManager.hasInFlightRun(input.agentId)).toBe(false);
    now = new Date(now.getTime() + 120_000);
    await Promise.all([freshService.tick(), freshService.tick()]);
    const stored = await freshService.inspect(job!.id);
    expect(stored.runs).toHaveLength(1);
    expect(stored.runs[0]).toMatchObject({
      agentId: input.agentId,
      status: "succeeded",
      output: "Continuation delivered",
    });
    expect(freshManager.getAgent(input.agentId)?.id).toBe(input.agentId);
    await freshManager.waitForAgentEvent(input.agentId, { waitForActive: true });
    await freshService.stop();
    await freshManager.closeAgent(input.agentId);
    await freshManager.flush();
  });

  test("the existing client's running-status steer path sends a new task and cancels the waiting job", async () => {
    const { service, manager, input } = await quotaFixture();
    const job = await service.armQuotaContinuation(input);
    expect(toAgentPayload(manager.getAgent(input.agentId)!).status).toBe("running");
    expect(manager.hasInFlightRun(input.agentId)).toBe(false);
    await startAgentRun(manager, input.agentId, "Replace this task", createTestLogger(), {
      activeTurnBehavior: "steer",
      replaceRunning: true,
    });
    await manager.waitForAgentRunStart(input.agentId);
    expect((await service.inspect(job!.id)).quotaContinuation?.cancelled).toBe(true);
    await manager.waitForAgentEvent(input.agentId, { waitForActive: true });
  });

  test("a changed latest user message fails continuation admission", async () => {
    const { service, manager, input } = await quotaFixture();
    const job = await service.armQuotaContinuation(input);
    // Another source of user history can arrive after the job was stored, including across recovery.
    await manager.closeAgent(input.agentId);
    const record = (await agentStorage.get(input.agentId))!;
    await agentStorage.upsert({
      ...record,
      lastUserMessageAt: new Date(now.getTime() + 1000).toISOString(),
    });
    now = new Date(now.getTime() + 120_000);
    await service.tick();
    expect((await service.inspect(job!.id)).runs[0].output).toBe(
      "Continuation cancelled or superseded",
    );
  });

  test("repeat five-hour quota stops permit only two rearms", async () => {
    const { service, input } = await quotaFixture();
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    let job = await service.armQuotaContinuation(input);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const nextTurn = `retry-turn-${attempt}`;
      await store.update(job!.id, (s) => ({
        ...s,
        status: "completed",
        nextRunAt: null,
        quotaContinuation: { ...s.quotaContinuation!, deliveredTurnId: nextTurn },
      }));
      const next = await service.armQuotaContinuation({ ...input, turnId: nextTurn });
      if (attempt <= 2) {
        expect(next?.quotaContinuation?.attempt).toBe(attempt);
        job = next;
      } else expect(next).toBeNull();
    }
  });

  test("equal Claude turn ordinals in different SDK runtimes are distinct persistent quota stops", async () => {
    const { service, manager, input } = await quotaFixture();
    const usage = vi.spyOn(manager, "usageSession");
    usage.mockReturnValue({ provider: "claude", env: {}, sessionKey: "runtime-one" });
    const event: Extract<AgentStreamEvent, { type: "turn_failed" }> = {
      type: "turn_failed",
      provider: "claude",
      turnId: "foreground-turn-1",
      error: "quota",
      subscriptionLimit: { type: "five_hour", resetsAt: input.resetsAt },
    };
    await service.handleQuotaStop(input.agentId, event, null);
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    const first = (await store.list())[0];
    await store.update(first.id, (s) => ({ ...s, status: "completed", nextRunAt: null }));
    usage.mockReturnValue({ provider: "claude", env: {}, sessionKey: "runtime-two" });
    await service.handleQuotaStop(input.agentId, event, null);
    await service.handleQuotaStop(input.agentId, event, null);
    const jobs = await store.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((s) => s.quotaContinuation?.turnId).sort()).toEqual([
      "runtime-one:foreground-turn-1",
      "runtime-two:foreground-turn-1",
    ]);
    expect(jobs.filter((s) => s.status === "active")).toHaveLength(1);
    const active = jobs.find((s) => s.status === "active")!;
    await store.update(active.id, (s) => ({
      ...s,
      status: "completed",
      nextRunAt: null,
      quotaContinuation: {
        ...s.quotaContinuation!,
        deliveredTurnId: "runtime-two:foreground-turn-2",
      },
    }));
    await service.handleQuotaStop(input.agentId, { ...event, turnId: "foreground-turn-2" }, null);
    const rearmed = (await store.list()).find((s) => s.status === "active")!;
    expect(rearmed.quotaContinuation?.attempt).toBe(1);
  });

  test.each(["new-agent", "agent", "maxRuns: 1"] as const)(
    "dispatches a shared cron slot only once for %s after an earlier tick resumes",
    async (targetKind) => {
      const runner = new OverlappingTickRunner();
      const service = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
        runner: (schedule) => runner.run(schedule),
      });
      const cadence = { type: "cron" as const, expression: "0 6 * * 1", timezone: "Europe/Prague" };
      await service.create({
        prompt: "block the first tick",
        cadence,
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      });
      // Give the later schedule a distinct creation time so file ordering cannot affect the race.
      now = new Date("2026-01-01T00:00:01.000Z");
      const agentId = "00000000-0000-0000-0000-000000000001";
      await agentStorage.upsert(
        buildAgentRecord({ id: agentId, cwd: tempDir, iso: now.toISOString() }),
      );
      const later = await service.create({
        prompt: "later due schedule",
        cadence,
        target:
          targetKind === "agent"
            ? { type: "agent", agentId }
            : { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
        maxRuns: targetKind === "maxRuns: 1" ? 1 : undefined,
      });
      now = new Date("2026-01-05T05:00:00.000Z");
      const delayedTick = service.tick();
      await runner.firstRunStarted;
      try {
        now = new Date("2026-01-05T05:00:01.000Z");
        await service.tick();
      } finally {
        runner.unblockFirstRun();
        await delayedTick;
      }
      const result = await service.inspect(later.id);
      expect.soft(runner.laterScheduleRuns).toBe(1);
      expect.soft(result.runs).toHaveLength(1);
      expect.soft(result.runs.map((run) => run.scheduledFor)).toEqual(["2026-01-05T05:00:00.000Z"]);
      expect(result.nextRunAt).toBe(
        targetKind === "maxRuns: 1" ? null : "2026-01-12T05:00:00.000Z",
      );
      expect(result.status).toBe(targetKind === "maxRuns: 1" ? "completed" : "active");
    },
  );

  test("advances the next scheduled slot past a run that crosses a cadence boundary", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        now = new Date("2026-01-01T00:02:00.000Z");
        return { agentId: null, output: "ok" };
      },
    });

    const created = await service.create({
      prompt: "long-running task",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    expect((await service.inspect(created.id)).nextRunAt).toBe("2026-01-01T00:03:00.000Z");
  });

  test("runs the final allowed cron slot without requiring another occurrence", async () => {
    let dispatches = 0;
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        dispatches += 1;
        return { agentId: null, output: "done" };
      },
    });
    const created = await service.create({
      prompt: "Run once on January 5 when it is Monday",
      cadence: { type: "cron", expression: "0 6 5 1 1" },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    now = new Date("2026-01-05T06:00:00.000Z");
    await service.tick();
    const result = await service.inspect(created.id);
    expect(dispatches).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.nextRunAt).toBeNull();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe("succeeded");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps firing future slots after an outcome could not be saved",
    async () => {
      const schedulesDir = join(tempDir, "schedules");
      let dispatches = 0;
      const failOutcomeWrite = async (): Promise<ScheduleExecutionResult> => {
        dispatches += 1;
        if (dispatches === 1) {
          await chmod(schedulesDir, 0o555);
        }
        return { agentId: null, output: "done" };
      };
      const service = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
        runner: failOutcomeWrite,
      });
      const created = await service.create({
        prompt: "Check status each minute",
        runOnCreate: false,
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      });
      now = new Date("2026-01-01T00:01:00.000Z");
      try {
        await expect(service.tick()).rejects.toThrow();
      } finally {
        await chmod(schedulesDir, 0o755);
      }
      expect((await service.inspect(created.id)).runs[0].status).toBe("running");
      now = new Date("2026-01-01T00:02:00.000Z");
      await service.tick();
      const result = await service.inspect(created.id);
      expect(dispatches).toBe(2);
      expect(result.runs.map((run) => run.scheduledFor)).toEqual([
        "2026-01-01T00:01:00.000Z",
        "2026-01-01T00:02:00.000Z",
      ]);
      expect(result.nextRunAt).toBe("2026-01-01T00:03:00.000Z");
    },
  );

  test("completes an interrupted final slot during restart recovery", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "done" }),
    });
    const created = await service.create({
      prompt: "Run once",
      cadence: { type: "cron", expression: "0 6 5 1 1" },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    now = new Date("2026-01-05T06:00:00.000Z");
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    await store.update(created.id, (schedule) => ({
      ...schedule,
      nextRunAt: null,
      runs: [
        {
          id: "interrupted-final-slot",
          scheduledFor: now.toISOString(),
          startedAt: now.toISOString(),
          endedAt: null,
          status: "running",
          agentId: null,
          output: null,
          error: null,
        },
      ],
    }));
    now = new Date("2026-01-05T06:01:00.000Z");
    await service.start();
    try {
      const result = await service.inspect(created.id);
      expect(result.status).toBe("completed");
      expect(result.nextRunAt).toBeNull();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].status).toBe("failed");
    } finally {
      await service.stop();
    }
  });

  test.each([2, null])(
    "keeps a next slot when the final run's limit changes to %s",
    async (maxRuns) => {
      const service = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
        runner: async (schedule) => {
          await service.update({ id: schedule.id, maxRuns });
          return { agentId: null, output: "done" };
        },
      });
      const created = await service.create({
        prompt: "Allow more runs during execution",
        runOnCreate: false,
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
        maxRuns: 1,
      });
      now = new Date("2026-01-01T00:01:30.000Z");
      await service.tick();
      const result = await service.inspect(created.id);
      expect(result.status).toBe("active");
      expect(result.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
      expect(result.runs).toHaveLength(1);
    },
  );

  test("pause and resume update persisted schedule state", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "ok",
      }),
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    now = new Date("2026-01-01T00:03:00.000Z");
    const resumed = await service.resume(created.id);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
  });

  test("completes schedules when max runs is reached", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "done",
      }),
    });

    const created = await service.create({
      prompt: "One shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
  });

  test("executes new-agent schedules through AgentManager with real fake clients", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    expect(inspected.runs[0]?.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("delivers agent-target schedules through the steer-or-interrupt path", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const agent = await manager.createAgent({ provider: "claude", cwd: tempDir }, undefined, {
      workspaceId: undefined,
    });
    const steerOrReplace = vi.spyOn(manager, "steerOrReplaceActiveTurn");
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });
    const schedule = await service.create({
      prompt: "Check scheduled work",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agent.id },
    });

    await service.runOnce(schedule.id);

    expect(steerOrReplace).toHaveBeenCalledTimes(1);
    expect(steerOrReplace.mock.calls[0]).toEqual([
      agent.id,
      expect.stringContaining(`Schedule fired (id=${schedule.id}, run=`),
      undefined,
    ]);
  });

  test("titles scheduled new agents from the schedule prompt", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Audit flaky checkout flow\n\nReport only blockers.",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.title).toBe("Audit flaky checkout flow");
  });

  test("new-agent schedule records create no workspace until run time", async () => {
    const { workspaceRegistry, createDirectoryWorkspace: createScheduleDirectoryWorkspace } =
      await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "server-owned workspace happens at run time",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      runOnCreate: false,
    });

    expect(created.target.config).toMatchObject({
      provider: "claude",
      model: "test-model",
      cwd: tempDir,
    });
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("archiveOnFinish=false local runs create one active workspace per run", async () => {
    const {
      workspaceRegistry,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      now: () => now,
    });

    const created = await service.create({
      prompt: "repeat in separate workspaces",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      maxRuns: 2,
    });

    await service.tick();
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(2);
    const firstAgent = await agentStorage.get(inspected.runs[0]!.agentId!);
    const secondAgent = await agentStorage.get(inspected.runs[1]!.agentId!);
    expect(firstAgent?.workspaceId).toMatch(/^wks_/);
    expect(secondAgent?.workspaceId).toMatch(/^wks_/);
    expect(firstAgent?.workspaceId).not.toBe(secondAgent?.workspaceId);
    expect(firstAgent?.archivedAt ?? null).toBeNull();
    expect(secondAgent?.archivedAt ?? null).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([
      expect.objectContaining({
        workspaceId: firstAgent?.workspaceId,
        cwd: tempDir,
        archivedAt: null,
      }),
      expect.objectContaining({
        workspaceId: secondAgent?.workspaceId,
        cwd: tempDir,
        archivedAt: null,
      }),
    ]);
  });

  test("archiveOnFinish=true archives the run workspace through workspace archive", async () => {
    const {
      workspaceRegistry,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const archiveAgent = manager.archiveAgent.bind(manager);
    manager.archiveAgent = async (agentId) => {
      if (!workspaceArchiveInProgress) {
        throw new Error("scheduled runs must archive workspaces, not agents directly");
      }
      return archiveAgent(agentId);
    };
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      now: () => now,
    });

    const created = await service.create({
      prompt: "archive the run workspace",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          isolation: "local",
        },
      },
      maxRuns: 1,
    });

    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.workspaceId).toMatch(/^wks_/);
    expect(storedAgent?.archivedAt).toEqual(expect.any(String));
    expect(await workspaceRegistry.get(storedAgent!.workspaceId!)).toEqual(
      expect.objectContaining({
        workspaceId: storedAgent?.workspaceId,
        archivedAt: expect.any(String),
      }),
    );
  });

  test("archives the run workspace when scheduled agent creation fails before archive opt-out can preserve an agent", async () => {
    const {
      workspaceRegistry,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const createError = new Error("provider misconfigured");
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createDirectoryWorkspace: createScheduleDirectoryWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      createAgent: async () => {
        throw createError;
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "fail before agent exists",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      runOnCreate: false,
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule(created, "run-create-fails"),
    ).rejects.toThrow("provider misconfigured");

    expect(await workspaceRegistry.list()).toEqual([
      expect.objectContaining({
        cwd: tempDir,
        archivedAt: expect.any(String),
      }),
    ]);
  });

  test("new-agent cwd existence is checked at run time, not when editing the schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "missing cwd can be configured",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: join(tempDir, "does-not-exist") },
      },
      runOnCreate: false,
    });

    const updated = await service.update({
      id: created.id,
      newAgentConfig: { cwd: join(tempDir, "also-missing") },
    });

    expect(updated.target.config).toMatchObject({
      provider: "claude",
      cwd: join(tempDir, "also-missing"),
    });
  });

  test("concurrent run finish and update preserve the target config and run outcome", async () => {
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    const legacy = await store.create({
      name: null,
      prompt: "finish/update race",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: now.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished while updating",
        };
      },
    });

    const tickPromise = service.tick();
    await runStarted;
    const updatePromise = service.update({
      id: legacy.id,
      newAgentConfig: { modeId: "full-access" },
    });
    finishRun?.();
    await Promise.all([tickPromise, updatePromise]);

    const inspected = await service.inspect(legacy.id);
    expect(inspected.target).toMatchObject({
      type: "new-agent",
      config: {
        modeId: "full-access",
      },
    });
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      output: "finished while updating",
      error: null,
    });
  });

  test("scheduled new-agent slash prompts run as normal foreground prompts", async () => {
    const createdInputs: Parameters<ScheduleServiceOptions["createAgent"]>[0][] = [];
    const runPrompts: AgentPromptInput[] = [];
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async (_agentId, prompt) => {
      runPrompts.push(prompt);
      return {
        sessionId: "scheduled-slash-run",
        finalText: "compacted",
        timeline: [{ type: "assistant_message", text: "compacted" }],
      };
    };
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: "compacted",
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        createdInputs.push(input);
        const snapshot = {
          id: "00000000-0000-0000-0000-000000000322",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "/compact",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0].initialPrompt).toBeUndefined();
    expect(runPrompts).toEqual(["/compact"]);
    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      output: "compacted",
    });
  });

  test("scheduled new-agent run output falls back to final text and curated timeline", async () => {
    let runCount = 0;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => {
      runCount += 1;
      return runCount === 1
        ? {
            sessionId: "scheduled-final-text-run",
            finalText: "final text output",
            timeline: [],
          }
        : {
            sessionId: "scheduled-timeline-run",
            finalText: "",
            timeline: [{ type: "assistant_message", text: "timeline output" }],
          };
    };
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: null,
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id:
            runCount === 0
              ? "00000000-0000-0000-0000-000000000323"
              : "00000000-0000-0000-0000-000000000324",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const finalTextSchedule = await service.create({
      prompt: "final text",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    const timelineSchedule = await service.create({
      prompt: "timeline",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });

    await service.runOnce(finalTextSchedule.id);
    await service.runOnce(timelineSchedule.id);

    expect((await service.inspect(finalTextSchedule.id)).runs[0]?.output).toBe("final text output");
    expect((await service.inspect(timelineSchedule.id)).runs[0]?.output).toContain(
      "timeline output",
    );
  });

  test("scheduled new-agent cancellations fail the run", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => ({
      sessionId: "scheduled-canceled-run",
      finalText: "",
      timeline: [],
      canceled: true,
    });
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: null,
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id: "00000000-0000-0000-0000-000000000325",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "cancel me",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("was canceled"),
    });
  });

  test("failed new-agent run keeps run error when workspace archive also fails", async () => {
    const logger = createTestLogger();
    const warn = vi.fn();
    logger.warn = warn as typeof logger.warn;
    logger.child = (() => logger) as typeof logger.child;
    const archiveError = new Error("archive exploded");
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => {
      throw new Error("run exploded");
    };
    const agentId = "00000000-0000-0000-0000-000000000326";
    const service = createScheduleService({
      paseoHome: tempDir,
      logger,
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id: agentId,
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      archiveWorkspace: async () => {
        throw archiveError;
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "fail and fail cleanup",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      error: "run exploded",
      agentId,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: archiveError,
        agentId,
        workspaceId: expect.stringMatching(/^wks_/),
        scheduleId: created.id,
        runId: expect.any(String),
      }),
      expect.stringContaining("Failed to archive scheduled workspace"),
    );
  });

  test("shows scheduled new-agent prompts as normal user turns", async () => {
    class PromptEchoScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-prompt-echo-session";
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      async run(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
        const turnId = `run-${++this.turnCount}`;
        const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        this.emit({ type: "turn_started", provider: this.provider, turnId });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "user_message", text: textPrompt },
        });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: "done" },
        });
        this.emit({
          type: "turn_completed",
          provider: this.provider,
          turnId,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        return {
          sessionId: this.id,
          finalText: "done",
          timeline: [{ type: "assistant_message", text: "done" }],
        };
      }

      async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnCount}`;
        const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        setImmediate(() => {
          this.emit({ type: "turn_started", provider: this.provider, turnId });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "user_message", text: textPrompt },
          });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: "done" },
          });
          this.emit({
            type: "turn_completed",
            provider: this.provider,
            turnId,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        });
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(_modeId: string): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        _response: AgentPermissionResponse,
      ): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}

      private emit(event: AgentStreamEvent): void {
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    }

    class PromptEchoScheduleClient implements AgentClient {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new PromptEchoScheduleSession();
      }

      async resumeSession(_handle: AgentPersistenceHandle): Promise<AgentSession> {
        return new PromptEchoScheduleSession();
      }

      async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
        return { models: [], modes: [] };
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: new PromptEchoScheduleClient() },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });
    const observedUserMessages: string[] = [];
    const unsubscribe = manager.subscribe((event) => {
      if (event.type !== "agent_stream" || event.event.type !== "timeline") {
        return;
      }
      if (event.event.item.type === "user_message") {
        observedUserMessages.push(event.event.item.text);
      }
    });

    const created = await service.create({
      prompt: "Audit nightly run",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    try {
      await service.tick();
    } finally {
      unsubscribe();
    }

    expect(observedUserMessages).toEqual(["Audit nightly run"]);
    expect((await service.inspect(created.id)).runs[0]?.status).toBe("succeeded");
  });

  test("archives new-agent schedule sessions after the run finishes", async () => {
    class CountingScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id: string;
      closed = false;
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      constructor(private readonly config: AgentSessionConfig) {
        this.id = "scheduled-session-1";
      }

      async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "done",
          timeline: [{ type: "assistant_message", text: "done" }],
        };
      }

      async startTurn(
        _prompt: AgentPromptInput,
        _options?: AgentRunOptions,
      ): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnCount}`;
        setImmediate(() => {
          this.emit({ type: "turn_started", provider: this.provider, turnId });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: "done" },
          });
          this.emit({
            type: "turn_completed",
            provider: this.provider,
            turnId,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        });
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: this.config.model ?? null,
          modeId: this.config.modeId ?? null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return this.config.modeId ?? null;
      }

      async setMode(modeId: string): Promise<void> {
        this.config.modeId = modeId;
      }

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        _response: AgentPermissionResponse,
      ): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
          metadata: { ...this.config },
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {
        this.closed = true;
      }

      private emit(event: AgentStreamEvent): void {
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    }

    class CountingScheduleClient implements AgentClient {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly sessions: CountingScheduleSession[] = [];

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new CountingScheduleSession(config);
        this.sessions.push(session);
        return session;
      }

      async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
        const metadata = handle.metadata as Partial<AgentSessionConfig> | undefined;
        const session = new CountingScheduleSession({
          ...metadata,
          provider: this.provider,
          cwd: metadata?.cwd ?? tempDir,
        });
        this.sessions.push(session);
        return session;
      }

      async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
        return { models: [], modes: [] };
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const client = new CountingScheduleClient();
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: client },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "finish and stop",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]?.closed).toBe(true);
    expect(manager.getAgent(agentId!)).toBeNull();
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.archivedAt).toBeTruthy();
  });

  test("records prompt-start failures as failed and archives the scheduled agent", async () => {
    class StartFailureScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-start-failure-session";

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("start turn exploded");
      }

      subscribe(): () => void {
        return () => {};
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: {
        claude: {
          provider: "claude",
          capabilities: SCHEDULE_TEST_CAPABILITIES,
          createSession: async () => new StartFailureScheduleSession(),
          resumeSession: async () => new StartFailureScheduleSession(),
          fetchCatalog: async () => ({ models: [], modes: [] }),
          isAvailable: async () => true,
        },
      },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "this run fails before starting",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: expect.any(String),
      error: expect.stringContaining("start turn exploded"),
    });
    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(1);
    expect(inspected.runs[0]?.agentId).toBe(storedAgents[0]?.id);
    expect(storedAgents[0]).toMatchObject({
      archivedAt: expect.any(String),
    });
  });

  test("defaults new-agent modeId to provider's unattended mode", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "bypassPermissions" : "interactive",
            featureValues: input.featureValues,
          };
        },
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    const agent = await agentStorage.get(agentId!);
    expect(agent?.lastModeId).toBe("bypassPermissions");
    expect(agent?.archivedAt).toBeTruthy();
  });

  test("defaults OpenCode new-agent schedules to build plus auto accept", async () => {
    const createdConfigs: AgentSessionConfig[] = [];
    const clients = createTestAgentClients();
    const opencodeClient = clients.opencode;
    if (!opencodeClient) {
      throw new Error("Expected OpenCode test client");
    }
    clients.opencode = {
      provider: opencodeClient.provider,
      capabilities: opencodeClient.capabilities,
      createSession: async (...args) => {
        createdConfigs.push(args[0]);
        return opencodeClient.createSession(...args);
      },
      resumeSession: (...args) => opencodeClient.resumeSession(...args),
      fetchCatalog: (...args) => opencodeClient.fetchCatalog(...args),
      isAvailable: () => opencodeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "build" : "interactive",
            featureValues: input.unattended
              ? { ...input.featureValues, auto_accept: true }
              : input.featureValues,
          };
        },
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "opencode",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]?.error).toBeNull();
    expect(createdConfigs[0]).toMatchObject({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
  });

  test("forwards stored new-agent session config to the launched scheduled agent", async () => {
    const createdConfigs: AgentSessionConfig[] = [];
    const clients = createTestAgentClients();
    const claudeClient = clients.claude;
    if (!claudeClient) {
      throw new Error("Expected Claude test client");
    }
    clients.claude = {
      provider: claudeClient.provider,
      capabilities: claudeClient.capabilities,
      createSession: async (...args) => {
        createdConfigs.push(args[0]);
        return claudeClient.createSession(...args);
      },
      resumeSession: (...args) => claudeClient.resumeSession(...args),
      fetchCatalog: (...args) => claudeClient.fetchCatalog(...args),
      isAvailable: () => claudeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      providerDefinitions: { claude: TEST_CLAUDE_PROVIDER_DEFINITION },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: "stored-mode",
          });
          return {
            modeId: input.requestedMode,
            featureValues: { ...input.featureValues, resolved: true },
          };
        },
      },
      now: () => now,
    });

    await service.create({
      prompt: "Use the stored launch config",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          title: "Stored launch title",
          modeId: "stored-mode",
          thinkingOptionId: "think-hard",
          providerOptions: {
            allowedTools: ["Read"],
            sandbox: { enabled: true, network: { allowLocalBinding: true } },
          },
          featureValues: { auto_accept: true },
          systemPrompt: "Stay concise.",
          mcpServers: {
            docs: {
              command: "node",
              args: ["docs-server.js"],
            },
          },
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0]).toMatchObject({
      provider: "claude",
      cwd: tempDir,
      title: "Stored launch title",
      model: "test-model",
      modeId: "stored-mode",
      thinkingOptionId: "think-hard",
      providerOptions: {
        allowedTools: ["Read"],
        sandbox: { enabled: true, network: { allowLocalBinding: true } },
      },
      featureValues: { auto_accept: true, resolved: true },
      systemPrompt: "Stay concise.",
      mcpServers: {
        docs: {
          command: "node",
          args: ["docs-server.js"],
        },
      },
    });
  });

  test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service1.create({
      prompt: "Periodic check",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
    await service1.stop();

    // Simulate daemon restart 10 minutes later
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();

    const inspected = await service2.inspect(created.id);
    expect(new Date(inspected.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    await service2.stop();
  });

  test("starts with the valid schedules when the schedules directory holds files that are not schedules", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Still scheduled",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const schedulesDir = join(tempDir, "schedules");
    await writeFile(join(schedulesDir, "notes.json"), JSON.stringify({ hello: "world" }));
    const { lastRunAt: _omitted, ...withoutLastRunAt } = created;
    await writeFile(
      join(schedulesDir, "deadbeef.json"),
      JSON.stringify({ ...withoutLastRunAt, id: "deadbeef" }),
    );
    await writeFile(join(schedulesDir, "broken.json"), "{ not json");

    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();

    expect((await service2.list()).map((schedule) => schedule.id)).toEqual([created.id]);
    await service2.stop();
  });

  test("startup recovery archives an interrupted run workspace with an associated agent", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Interrupted after creating an agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const interruptedAt = now.toISOString();
    const associatedAgentId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "wks_interrupted_with_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    await store.update(created.id, (schedule) => ({
      ...schedule,
      runs: [
        ...schedule.runs,
        {
          id: "run-interrupted-with-agent",
          scheduledFor: interruptedAt,
          startedAt: interruptedAt,
          endedAt: null,
          status: "running",
          agentId: associatedAgentId,
          workspaceId,
          output: null,
          error: null,
        },
      ],
    }));

    const archiveCalls: string[] = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
      archiveWorkspace: async (archivedWorkspaceId) => {
        archiveCalls.push(archivedWorkspaceId);
      },
    });
    await service2.start();

    expect(archiveCalls).toEqual([workspaceId]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: associatedAgentId,
      error: "Daemon restarted before the scheduled run completed",
    });
    await service2.stop();
  });

  test("startup recovery archives an interrupted run workspace even before agent association", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Interrupted before creating an agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, archiveOnFinish: false },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const interruptedAt = now.toISOString();
    const workspaceId = "wks_interrupted_without_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"), createTestLogger());
    await store.update(created.id, (schedule) => ({
      ...schedule,
      runs: [
        ...schedule.runs,
        {
          id: "run-interrupted-without-agent",
          scheduledFor: interruptedAt,
          startedAt: interruptedAt,
          endedAt: null,
          status: "running",
          agentId: null,
          workspaceId,
          output: null,
          error: null,
        },
      ],
    }));

    const archiveCalls: string[] = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
      archiveWorkspace: async (archivedWorkspaceId) => {
        archiveCalls.push(archivedWorkspaceId);
      },
    });
    await service2.start();

    expect(archiveCalls).toEqual([workspaceId]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: null,
      error: "Daemon restarted before the scheduled run completed",
    });
    await service2.stop();
  });

  test("keeps schedules paused when an in-flight run finishes after pause", async () => {
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished",
        };
      },
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    const tickPromise = service.tick();
    await runStarted;

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    finishRun?.();
    await tickPromise;

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("paused");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("rejects archived target agents before loading them", async () => {
    const manager = new AgentManager({ logger: createTestLogger() });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    await agentStorage.upsert({
      id: "archived-agent",
      provider: "claude",
      cwd: tempDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      lastUserMessageAt: null,
      title: "Archived Agent",
      labels: {},
      lastStatus: "closed",
      lastModeId: "default",
      config: {
        modeId: "default",
      },
      runtimeInfo: null,
      features: [],
      persistence: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule(
        {
          id: "schedule-1",
          name: null,
          prompt: "Check archived agent",
          cadence: { type: "every", everyMs: 60_000 },
          target: {
            type: "agent",
            agentId: "archived-agent",
          },
          status: "active",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          nextRunAt: now.toISOString(),
          lastRunAt: null,
          pausedAt: null,
          expiresAt: null,
          maxRuns: null,
          runs: [],
        },
        "run-1",
      ),
    ).rejects.toThrow("Agent archived-agent is archived");
  });

  test("defaults --every schedules to fire immediately on creation", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "every default",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("--every with runOnCreate=false waits the full interval", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "wait interval",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });

  test("--cron defaults to the next cron slot", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron default",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
  });

  test("--cron with runOnCreate=true fires immediately on creation", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron run-now",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: true,
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("runOnce records a run without changing nextRunAt or completing the schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000099",
        output: `manual:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "manual fire",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const after = await service.runOnce(created.id);
    expect(after.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(after.status).toBe("active");
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000099",
      output: "manual:manual fire",
    });
  });

  test("update mutates cadence, prompt, name, and target fields in place", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "morning",
      prompt: "first prompt",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, modeId: "default" },
      },
    });
    expect(created.runs).toEqual([]);

    now = new Date("2026-01-01T00:00:30.000Z");
    const nextCwd = join(tempDir, "new-path");
    await mkdir(nextCwd, { recursive: true });
    const updated = await service.update({
      id: created.id,
      prompt: "second prompt",
      name: "renamed",
      cadence: { type: "every", everyMs: 5 * 60_000 },
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        thinkingOptionId: "deep-thought",
        archiveOnFinish: false,
        isolation: "worktree",
        cwd: nextCwd,
      },
    });

    expect(updated.prompt).toBe("second prompt");
    expect(updated.name).toBe("renamed");
    expect(updated.cadence).toEqual({ type: "every", everyMs: 5 * 60_000 });
    expect(updated.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: nextCwd,
        model: "gpt-5",
        modeId: "full-access",
        thinkingOptionId: "deep-thought",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    });
    expect(updated.nextRunAt).toBe("2026-01-01T00:05:30.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  test("update switches between every and cron cadences and recomputes nextRunAt", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:00:00.000Z");

    const cron = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
    expect(cron.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(cron.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const back = await service.update({
      id: created.id,
      cadence: { type: "every", everyMs: 2 * 60_000 },
    });
    expect(back.cadence).toEqual({ type: "every", everyMs: 2 * 60_000 });
    expect(back.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("update preserves a cron cadence timezone when the new cadence omits it", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: {
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    const updated = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });

    expect(updated.cadence).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("update preserves nextRunAt and run history when cadence is unchanged", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ran" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const after = await service.inspect(created.id);
    expect(after.runs).toHaveLength(1);

    now = new Date("2026-01-01T00:01:30.000Z");
    const updated = await service.update({ id: created.id, prompt: "new prompt" });

    expect(updated.prompt).toBe("new prompt");
    expect(updated.cadence).toEqual(created.cadence);
    expect(updated.nextRunAt).toBe(after.nextRunAt);
    expect(updated.runs).toEqual(after.runs);
    expect(updated.lastRunAt).toBe(after.lastRunAt);
  });

  test("update clears the schedule name when given an empty string", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "named",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.name).toBe("named");

    const cleared = await service.update({ id: created.id, name: "" });
    expect(cleared.name).toBeNull();

    const renamed = await service.update({ id: created.id, name: "again" });
    expect(renamed.name).toBe("again");
  });

  test("update rejects new-agent fields on agent-target schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "agent target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000005" },
    });

    await expect(
      service.update({
        id: created.id,
        newAgentConfig: { provider: "codex" },
      }),
    ).rejects.toThrow("only valid for new-agent target schedules");
  });

  test("update changes individual new-agent fields independently", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, model: "sonnet", modeId: "default" },
      },
    });

    const modeOnly = await service.update({
      id: created.id,
      newAgentConfig: { modeId: "bypassPermissions" },
    });
    expect(modeOnly.target).toMatchObject({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: tempDir,
        model: "sonnet",
        modeId: "bypassPermissions",
      },
    });

    const clearModel = await service.update({
      id: created.id,
      newAgentConfig: { model: null },
    });
    if (clearModel.target.type !== "new-agent") {
      throw new Error("target type changed unexpectedly");
    }
    expect(clearModel.target.config.model).toBeUndefined();
    expect(clearModel.target.config.modeId).toBe("bypassPermissions");
  });

  test("update returns a schedule that round-trips through the store", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "0 9 * * *" },
      newAgentConfig: { provider: "codex", modeId: "full-access" },
    });

    const reloaded = await service.inspect(created.id);
    expect(reloaded.cadence).toEqual({ type: "cron", expression: "0 9 * * *" });
    expect(reloaded.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: tempDir,
        modeId: "full-access",
      },
    });
  });

  test("runOnce rejects completed schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "one-shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    await expect(service.runOnce(created.id)).rejects.toThrow("already completed");
  });

  test("completeForAgent completes only schedules targeting that agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const targetAgentId = "11111111-1111-4111-8111-111111111111";
    const otherAgentId = "22222222-2222-4222-8222-222222222222";

    const targeted = await service.create({
      prompt: "ping the doomed agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: targetAgentId },
    });
    const otherTargeted = await service.create({
      prompt: "ping the other agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: otherAgentId },
    });
    const newAgentSchedule = await service.create({
      prompt: "spawn a fresh agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    now = new Date("2026-01-01T00:05:00.000Z");
    const completed = await service.completeForAgent(targetAgentId);
    expect(completed).toBe(1);

    const remaining = await service.list();
    expect(remaining.map((schedule) => schedule.id).sort()).toEqual(
      [targeted.id, otherTargeted.id, newAgentSchedule.id].sort(),
    );

    const doomed = await service.inspect(targeted.id);
    expect(doomed.status).toBe("completed");
    expect(doomed.nextRunAt).toBeNull();
    expect(doomed.updatedAt).toBe("2026-01-01T00:05:00.000Z");

    expect((await service.inspect(otherTargeted.id)).status).toBe("active");
    expect((await service.inspect(newAgentSchedule.id)).status).toBe("active");
  });

  test("startup sweep completes agent-target schedules whose agent is gone", async () => {
    const missingAgentId = "44444444-4444-4444-8444-444444444444";
    const archivedAgentId = "55555555-5555-4555-8555-555555555555";
    const liveAgentId = "66666666-6666-4666-8666-666666666666";

    await agentStorage.upsert(
      buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z",
      }),
    );
    await agentStorage.upsert(
      buildAgentRecord({ id: liveAgentId, cwd: tempDir, iso: now.toISOString() }),
    );

    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const missing = await service1.create({
      prompt: "ping missing",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: missingAgentId },
    });
    const archived = await service1.create({
      prompt: "ping archived",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: archivedAgentId },
    });
    const live = await service1.create({
      prompt: "ping live",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: liveAgentId },
    });
    const newAgent = await service1.create({
      prompt: "spawn fresh",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const pausedMissing = await service1.create({
      prompt: "paused ping missing",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" },
    });
    await service1.pause(pausedMissing.id);
    const pausedLive = await service1.create({
      prompt: "paused ping live",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: liveAgentId },
    });
    await service1.pause(pausedLive.id);

    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();
    await service2.stop();

    expect((await service2.inspect(missing.id)).status).toBe("completed");
    expect((await service2.inspect(missing.id)).nextRunAt).toBeNull();
    expect((await service2.inspect(archived.id)).status).toBe("completed");
    expect((await service2.inspect(live.id)).status).toBe("active");
    expect((await service2.inspect(newAgent.id)).status).toBe("active");
    // Paused schedules are swept too when their agent is gone, but survive when it lives.
    expect((await service2.inspect(pausedMissing.id)).status).toBe("completed");
    expect((await service2.inspect(pausedLive.id)).status).toBe("paused");
  });

  test("completes the schedule when a scheduled run reports the target is gone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        throw new ScheduleTargetGoneError("Agent 77777777-7777-4777-8777-777777777777 is archived");
      },
    });

    const created = await service.create({
      prompt: "ping gone target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "77777777-7777-4777-8777-777777777777" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("Agent 77777777-7777-4777-8777-777777777777 is archived");
  });

  test("does not resurrect nextRunAt when the schedule completes during an in-flight run", async () => {
    const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let service!: ScheduleService;
    service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        // Simulate the agent being archived mid-run: the archive callback
        // completes the schedule before this run finishes.
        await service.completeForAgent(agentId);
        return { agentId: null, output: "ok" };
      },
    });

    const created = await service.create({
      prompt: "ping",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("keeps the schedule active when a run fails for a transient reason", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        throw new Error("network blip");
      },
    });

    const created = await service.create({
      prompt: "ping flaky target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "88888888-8888-4888-8888-888888888888" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("network blip");
  });

  // chmod cannot make a directory unwritable on Windows or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fires again after a tick whose run could not be recorded",
    async () => {
      const service = createScheduleService({
        paseoHome: tempDir,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
        now: () => now,
        runner: async () => ({ agentId: null, output: "ran" }),
      });

      const created = await service.create({
        prompt: "ping target",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId: "88888888-8888-4888-8888-888888888888" },
      });

      const schedulesDir = join(tempDir, "schedules");
      now = new Date("2026-01-01T00:01:00.000Z");
      await chmod(schedulesDir, 0o555);
      try {
        await expect(service.tick()).rejects.toThrow();
      } finally {
        await chmod(schedulesDir, 0o755);
      }

      await service.tick();

      const inspected = await service.inspect(created.id);
      expect(inspected.runs).toHaveLength(1);
      expect(inspected.runs[0]?.status).toBe("succeeded");
      expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    },
  );

  test("completes the schedule when a scheduled run targets an archived agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const archivedAgentId = "99999999-9999-4999-8999-999999999999";
    await agentStorage.upsert(
      buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z",
      }),
    );

    const created = await service.create({
      prompt: "ping archived target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: archivedAgentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("is archived");
  });

  test("completes the schedule when a scheduled run targets a missing agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "ping missing target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
  });

  test("completes the schedule when a new-agent run's cwd no longer exists", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const deletedWorktree = join(tempDir, "deleted-worktree");
    await mkdir(deletedWorktree, { recursive: true });
    const created = await service.create({
      prompt: "spawn in a deleted dir",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: deletedWorktree,
          providerOptions: { allowedTools: ["Read"] },
        },
      },
    });
    await rm(deletedWorktree, { recursive: true, force: true });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("no longer exists");
  });

  test("keeps the schedule active when a real run fails for a non-gone reason", async () => {
    // No providers registered: the agent exists and is live, but loading it fails
    // with a plain error (not ScheduleTargetGoneError), so the schedule must retry.
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const agentId = "12121212-1212-4121-8121-121212121212";
    await agentStorage.upsert(
      buildAgentRecord({ id: agentId, cwd: tempDir, iso: now.toISOString() }),
    );

    const created = await service.create({
      prompt: "ping live but unavailable",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("unavailable provider");
  });

  test("runOnce completes the schedule when the target is gone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "manual ping gone target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "13131313-1313-4131-8131-131313131313" },
    });

    const after = await service.runOnce(created.id);
    expect(after.status).toBe("completed");
    expect(after.nextRunAt).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]?.status).toBe("failed");
  });

  test("createOrReplace updates the matching schedule in place instead of duplicating", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
      name: "babysit-pr PR 1112",
      prompt: "watch the build",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(first.id)).runs).toHaveLength(1);
    await service.pause(first.id);

    now = new Date("2026-01-01T00:02:00.000Z");
    const second = await service.createOrReplace({
      name: "babysit-pr PR 1112",
      prompt: "watch the build v2",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: { type: "agent", agentId },
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.prompt).toBe("watch the build v2");
    expect(second.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(second.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.runs).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace preserves an existing cron timezone when replacement omits timezone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
      name: "timezone-aware cron",
      prompt: "watch the build",
      cadence: { type: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
      target: { type: "agent", agentId },
    });

    const second = await service.createOrReplace({
      name: "timezone-aware cron",
      prompt: "watch the build v2",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: { type: "agent", agentId },
    });

    expect(second.id).toBe(first.id);
    expect(second.cadence).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace creates a sibling when name, target, or completion differ", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const agentB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await service.createOrReplace({
      name: "dup",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    await service.createOrReplace({
      name: "other",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    await service.createOrReplace({
      name: "dup",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentB },
    });

    const done = await service.createOrReplace({
      name: "done",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(done.id)).status).toBe("completed");

    const redone = await service.createOrReplace({
      name: "done",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    expect(redone.id).not.toBe(done.id);

    expect(await service.list()).toHaveLength(5);
  });

  test("createOrReplace never dedups anonymous schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await service.createOrReplace({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });
    await service.createOrReplace({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    expect(await service.list()).toHaveLength(2);
  });

  test("createOrReplace matches new-agent targets by config", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const first = await service.createOrReplace({
      name: "nightly",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const second = await service.createOrReplace({
      name: "nightly",
      prompt: "audit v2",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);

    const subCwd = join(tempDir, "sub");
    await mkdir(subCwd, { recursive: true });
    const third = await service.createOrReplace({
      name: "nightly",
      prompt: "audit elsewhere",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: subCwd } },
    });
    expect(third.id).not.toBe(first.id);
    expect(await service.list()).toHaveLength(2);
  });

  test("concurrent createOrReplace first creates share one schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const firstPromise = service.createOrReplace({
      name: "nightly race",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const secondPromise = service.createOrReplace({
      name: "nightly race",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace dedups new-agent targets regardless of config key order", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    // The stored config is round-tripped through the Zod schema (schema key
    // order); this incoming literal deliberately uses a different key order.
    const first = await service.createOrReplace({
      name: "nightly",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          providerOptions: { allowedTools: ["Read"] },
          title: "nightly job",
        },
      },
    });
    const second = await service.createOrReplace({
      name: "nightly",
      prompt: "audit v2",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          providerOptions: { allowedTools: ["Read"] },
          title: "nightly job",
        },
      },
    });

    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
  });

  test("completeForAgent skips schedules that are already completed", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "33333333-3333-4333-8333-333333333333";
    await service.create({
      prompt: "already done",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    expect(await service.completeForAgent(agentId)).toBe(1);
    expect(await service.completeForAgent(agentId)).toBe(0);
  });
});
