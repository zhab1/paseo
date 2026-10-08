import { describe, expect, test } from "vitest";
import { PAGED_HISTORY_ORIGIN } from "../agent-timeline-store.js";
import { ProviderSubagentStore } from "./store.js";
import type { ImportedTimelineEntry } from "../agent-sdk-types.js";

describe("ProviderSubagentStore", () => {
  test("prepends deferred history once while preserving concurrent live output and paging", async () => {
    const store = new ProviderSubagentStore();
    store.apply("parent", "codex", { type: "upsert", id: "child" });
    const before = store.fetchTimeline("parent", "child");
    let finish!: (history: ImportedTimelineEntry[]) => void;
    let calls = 0;
    const history = new Promise<ImportedTimelineEntry[]>((resolve) => {
      finish = resolve;
    });
    const load = () => {
      calls++;
      return history;
    };
    const first = store.hydrateTimeline("parent", "child", load);
    const second = store.hydrateTimeline("parent", "child", load);
    store.apply("parent", "codex", {
      type: "timeline",
      id: "child",
      item: { type: "assistant_message", messageId: "live", text: "New reply" },
    });
    finish([
      {
        item: { type: "assistant_message", messageId: "old", text: "Saved reply" },
        timestamp: "2026-09-27T00:00:00Z",
      },
    ]);
    await Promise.all([first, second]);
    await store.hydrateTimeline("parent", "child", load);
    expect(calls).toBe(1);
    expect(store.fetchTimeline("parent", "child").rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", messageId: "old", text: "Saved reply" },
      { type: "assistant_message", messageId: "live", text: "New reply" },
    ]);
    expect(
      store.fetchTimeline("parent", "child", {
        cursor: { epoch: before.epoch, seq: 0 },
        direction: "after",
      }).gap,
    ).toBe(true);
    expect(store.fetchTimeline("parent", "child").epoch).toBe(before.epoch);
    expect(store.fetchTimeline("parent", "child", { limit: 1 }).hasOlder).toBe(true);
  });

  test("failed deferred reads retry without losing live output", async () => {
    const store = new ProviderSubagentStore();
    store.apply("parent", "codex", { type: "upsert", id: "child" });
    store.apply("parent", "codex", {
      type: "timeline",
      id: "child",
      item: { type: "assistant_message", messageId: "live", text: "Live" },
    });
    await expect(
      store.hydrateTimeline("parent", "child", async () => {
        throw new Error("read failed");
      }),
    ).rejects.toThrow("read failed");
    expect(store.fetchTimeline("parent", "child").rows).toHaveLength(1);
    await store.hydrateTimeline("parent", "child", async () => [
      { item: { type: "assistant_message", messageId: "old", text: "Saved" } },
    ]);
    expect(store.fetchTimeline("parent", "child").rows).toHaveLength(2);
  });

  test("discarding a parent invalidates an outstanding history read", async () => {
    const store = new ProviderSubagentStore();
    store.apply("parent", "codex", { type: "upsert", id: "child" });
    let finish!: (history: ImportedTimelineEntry[]) => void;
    const history = new Promise<ImportedTimelineEntry[]>((resolve) => {
      finish = resolve;
    });
    const pending = store.hydrateTimeline("parent", "child", () => history);
    store.deleteParent("parent");
    store.apply("parent", "codex", { type: "upsert", id: "child" });
    finish([{ item: { type: "assistant_message", text: "Stale" } }]);
    await expect(pending).rejects.toThrow("reloaded");
    expect(store.fetchTimeline("parent", "child").rows).toEqual([]);
  });

  test("keeps provider children and their timelines scoped to the parent agent", () => {
    const subagents = new ProviderSubagentStore();

    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      cwd: "/workspace/child",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "Found it." },
      timestamp: "2026-07-12T10:00:01.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      status: "completed",
      timestamp: "2026-07-12T10:00:02.000Z",
    });
    subagents.apply("parent-b", "claude", {
      type: "upsert",
      id: "child-1",
      title: "Review",
      status: "running",
      timestamp: "2026-07-12T10:00:03.000Z",
    });

    expect(subagents.list("parent-a")).toEqual([
      expect.objectContaining({
        id: "child-1",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Explore",
        cwd: "/workspace/child",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
      }),
    ]);
    expect(subagents.fetchTimeline("parent-a", "child-1").rows).toMatchObject([
      {
        seq: PAGED_HISTORY_ORIGIN,
        timestamp: "2026-07-12T10:00:01.000Z",
        item: { type: "assistant_message", text: "Found it." },
      },
    ]);
    expect(subagents.list("parent-b")[0]).toMatchObject({ provider: "claude", title: "Review" });
    expect(subagents.deleteParent("parent-a")).toEqual([
      { type: "remove", parentAgentId: "parent-a", subagentId: "child-1" },
    ]);
    expect(subagents.list("parent-a")).toEqual([]);
    expect(subagents.list("parent-b")).toHaveLength(1);
  });

  test("limits oversized provider child tool output before storage", () => {
    const subagents = new ProviderSubagentStore();
    const output = "x".repeat(70 * 1024);
    const update = subagents.apply("parent-a", "opencode", {
      type: "timeline",
      id: "child-1",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "print", output },
      },
    });

    expect(update.type).toBe("timeline");
    const [row] = subagents.fetchTimeline("parent-a", "child-1").rows;
    expect(row?.item).toMatchObject({
      type: "tool_call",
      detail: { type: "shell", output: "x".repeat(64 * 1024) },
    });
  });

  test("pages provider history on projected item boundaries", () => {
    const subagents = new ProviderSubagentStore();
    for (let index = 0; index < 101; index += 1) {
      subagents.apply("parent-a", "opencode", {
        type: "timeline",
        id: "child-1",
        item: { type: "assistant_message", text: String(index) },
      });
    }

    const page = subagents.fetchTimeline("parent-a", "child-1", {
      direction: "tail",
      limit: 1,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.seqStart).toBe(1);
    expect(page.rows[0]?.item).toMatchObject({
      text: Array.from({ length: 101 }, (_, i) => String(i)).join(""),
    });
    expect(page.rows.at(-1)?.seq).toBe(101);
    expect(page.hasOlder).toBe(false);
  });
});
