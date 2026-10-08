import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { TimelineCache } from "./timeline-cache.js";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore, PAGED_HISTORY_ORIGIN } from "./agent-timeline-store.js";

describe.each(["memory", "disk"])("timeline store (%s)", (backend) => {
  let cache: TimelineCache | undefined;
  let directory: string | undefined;
  beforeEach(() => {
    if (backend === "disk") {
      directory = path.join(process.cwd(), ".dev", "timeline-cache-tests", randomUUID());
      cache = new TimelineCache(path.join(directory, "timeline.sqlite"));
    }
  });
  afterEach(() => {
    cache?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    cache = undefined;
  });
  const createStore = () => new InMemoryAgentTimelineStore(cache);

  it("identifies assistant messages continued from an older page", () => {
    const store = createStore();
    store.initialize("agent-1", { epoch: "epoch-1" });
    store.append("agent-1", { type: "assistant_message", messageId: "message-a", text: "The" });
    store.append("agent-1", { type: "reasoning", text: "interleaved" });
    store.append("agent-1", { type: "assistant_message", messageId: "message-a", text: " brief" });
    store.append("agent-1", { type: "assistant_message", messageId: "message-b", text: "Done" });

    const tail = store.fetch("agent-1", { limit: 2 });
    expect(tail.priorAssistantMessageIds).toEqual(["message-a"]);
    expect(tail.rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", messageId: "message-a", text: " brief" },
      { type: "assistant_message", messageId: "message-b", text: "Done" },
    ]);

    expect(
      store.fetch("agent-1", {
        direction: "before",
        cursor: { epoch: "epoch-1", seq: tail.startSeq ?? 0 },
        limit: 2,
      }).priorAssistantMessageIds,
    ).toEqual([]);
  });

  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = createStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = createStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  describe("projected timeline retention", () => {
    it("retains one full tool state while streaming every source update", () => {
      const store = createStore();
      store.initialize("agent");
      for (let seq = 1; seq <= 2000; seq++) {
        const item = {
          type: "tool_call" as const,
          callId: "child",
          name: "task",
          status: "running" as const,
          error: null,
          detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
        };
        expect(store.append("agent", item)).toMatchObject({ seq, item });
      }
      const result = store.fetch("agent", { limit: 0 });
      expect(result.rows).toHaveLength(1);
      expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
      expect(result.window.maxSeq).toBe(2000);
    });

    it("catches up a mid-message cursor with the complete projected message", () => {
      const store = createStore();
      store.initialize("agent", { epoch: "e" });
      store.append("agent", { type: "assistant_message", messageId: "m", text: "A" });
      store.append("agent", { type: "assistant_message", messageId: "m", text: "B" });
      // Reconnect sends the complete projected message, including the original prefix.
      // Its own anchor preceding the cursor is not an earlier, separate message.
      expect(
        store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } })
          .priorAssistantMessageIds,
      ).toEqual([]);
      expect(
        store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } }).rows,
      ).toMatchObject([
        {
          item: { text: "AB" },
          seqStart: 1,
          seqEnd: 2,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
        },
      ]);
    });
  });

  describe("projected sequence ownership", () => {
    it("preserves fetched coverage when another source chunk arrives", () => {
      const store = createStore();
      store.initialize("a");
      store.append("a", { type: "assistant_message", text: "A" });
      const before = store.fetch("a");
      store.append("a", { type: "assistant_message", text: "B" });
      expect(before.rows[0]).toMatchObject({
        item: { text: "A" },
        seqEnd: 1,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
      });
      expect(store.fetch("a").rows[0]).toMatchObject({
        item: { text: "AB" },
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      });
    });
    it("preserves source positions when seeding a projected history whose last update is an earlier tool", () => {
      const store = createStore();
      store.initialize("a");
      const tool = {
        type: "tool_call" as const,
        callId: "t",
        name: "shell",
        error: null,
        detail: { type: "plain_text" as const, label: "work" },
      };
      store.append("a", { ...tool, status: "running" });
      store.append("a", { type: "assistant_message", text: "Answer" });
      store.append("a", { ...tool, status: "completed" });
      store.initialize("b", { rows: store.getRows("a") });
      expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
      expect(store.fetch("b").rows).toMatchObject([
        { seqStart: 1 },
        { seqStart: 2 },
        { seqStart: 4 },
      ]);
    });
    it("returns the last projected assistant message without joining different messages", () => {
      const store = createStore();
      store.initialize("a");
      store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
      store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
      store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
      expect(store.getLastAssistantMessage("a")).toBe("Second");
    });
  });

  it("keeps a tail bounded when older tools complete across the selected window", () => {
    const store = createStore();
    store.initialize("a");
    const tool = (callId: string, status: "running" | "completed") => ({
      type: "tool_call" as const,
      callId,
      name: "shell",
      status,
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    });
    store.append("a", tool("first", "running"));
    store.append("a", tool("second", "running"));
    store.append("a", { type: "user_message", text: "Continue" });
    store.append("a", tool("first", "completed"));
    store.append("a", { type: "assistant_message", text: "Answer" });
    store.append("a", tool("second", "completed"));
    const tail = store.fetch("a", { limit: 1 });
    expect(tail.rows.map((row) => row.seqStart)).toEqual([5]);
    expect(tail).toMatchObject({ startSeq: 5, endSeq: 6, hasOlder: true, reset: true });
    const older = store.fetch("a", {
      direction: "before",
      cursor: { epoch: tail.epoch, seq: 5 },
      limit: 3,
    });
    expect(older.rows.map((row) => row.seqStart)).toEqual([1, 2, 3]);
    expect(older.rows.slice(0, 2).map((row) => row.item)).toEqual([
      tool("first", "completed"),
      tool("second", "completed"),
    ]);
    expect(older).toMatchObject({ hasOlder: false, reset: false });
  });

  it("does not download intervening history for one old tool update", () => {
    const store = createStore();
    store.initialize("a");
    const tool = {
      type: "tool_call" as const,
      callId: "old-child",
      name: "task",
      error: null,
      detail: { type: "plain_text" as const, label: "Child" },
    };
    store.append("a", { ...tool, status: "running" });
    for (let i = 0; i < 1000; i++) {
      store.append("a", { type: "assistant_message", messageId: String(i), text: String(i) });
    }
    store.append("a", { ...tool, status: "completed" });
    const tail = store.fetch("a", { limit: 40 });
    expect(tail.rows).toHaveLength(40);
    expect(tail.rows[0].item).toEqual({
      type: "assistant_message",
      messageId: "960",
      text: "960",
    });
    expect(tail).toMatchObject({ startSeq: 962, endSeq: 1002, hasOlder: true, reset: true });
    const catchUp = store.fetch("a", {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: 1001 },
      limit: 40,
    });
    expect(catchUp.rows).toHaveLength(1);
    expect(catchUp.rows[0].item).toEqual({ ...tool, status: "completed" });
    expect(catchUp).toMatchObject({ reset: false, hasNewer: false, endSeq: 1002 });
  });

  it("opens the latest page, reads older pages on demand, and keeps live cursors stable", async () => {
    const store = createStore();
    const item = (n: number) => ({
      type: "assistant_message" as const,
      messageId: `m${n}`,
      text: `message ${n}`,
    });
    store.initialize("a", { nextSeq: PAGED_HISTORY_ORIGIN, items: [item(5), item(6)] });
    const older = [
      [item(3), item(4)],
      [item(1), item(2)],
    ];
    let calls = 0;
    const history = {
      hasOlder: () => older.length > 0,
      loadOlder: async () => {
        calls++;
        return older.shift()!.map((entry) => ({ item: entry }));
      },
    };
    const tail = await store.fetchPage("a", { limit: 2 }, history);
    expect(calls).toBe(0);
    expect(tail.hasOlder).toBe(true);
    const live = store.append("a", item(7));
    const middle = await store.fetchPage(
      "a",
      { direction: "before", limit: 2, cursor: { epoch: tail.epoch, seq: tail.startSeq! } },
      history,
    );
    expect(middle.rows.map((r) => r.item)).toEqual([item(3), item(4)]);
    expect(calls).toBe(1);
    const first = await store.fetchPage(
      "a",
      { direction: "before", limit: 2, cursor: { epoch: tail.epoch, seq: middle.startSeq! } },
      history,
    );
    expect(first.rows.map((r) => r.item)).toEqual([item(1), item(2)]);
    expect(first.hasOlder).toBe(false);
    expect(first.startSeq).toBeGreaterThan(0);
    const after = store.fetch("a", {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: tail.endSeq! },
    });
    expect(after.rows.map((r) => r.item)).toEqual([item(7)]);
    expect(after.endSeq).toBe(live.seq);
    expect(store.getItemCount("a")).toBe(7);
  });

  it("merges a message split at the fetched page boundary", () => {
    const store = createStore();
    store.initialize("a", {
      nextSeq: PAGED_HISTORY_ORIGIN,
      items: [{ type: "assistant_message", messageId: "m", text: "newer" }],
    });
    const tail = store.fetch("a");
    store.prepend("a", [{ item: { type: "assistant_message", messageId: "m", text: "older " } }]);
    const merged = store.fetch("a");
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].item).toMatchObject({ text: "older newer" });
    expect(merged.endSeq).toBe(tail.endSeq);
  });

  it("shares an older-page read across concurrent clients without duplicate rows", async () => {
    const store = createStore();
    store.initialize("a", {
      nextSeq: PAGED_HISTORY_ORIGIN,
      items: [{ type: "user_message", text: "latest" }],
    });
    const tail = store.fetch("a");
    let calls = 0;
    let more = true;
    const history = {
      hasOlder: () => more,
      loadOlder: async () => {
        calls++;
        await Promise.resolve();
        more = false;
        return [{ item: { type: "user_message" as const, text: "old" } }];
      },
    };
    const options = {
      direction: "before" as const,
      limit: 1,
      cursor: { epoch: tail.epoch, seq: tail.startSeq! },
    };
    const [a, b] = await Promise.all([
      store.fetchPage("a", options, history),
      store.fetchPage("a", options, history),
    ]);
    expect(a.rows).toEqual(b.rows);
    expect(calls).toBe(1);
    expect(store.getItemCount("a")).toBe(2);
  });
});

it.each(["tool", "assistant", "child"])(
  "serves all 125 MiB of cached %s history in pages with a 96 MiB heap",
  (kind) => {
    const fixture = fileURLToPath(
      new URL("./test-utils/timeline-cache-memory-repro.ts", import.meta.url),
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--max-old-space-size=96", "--expose-gc", "--import", "tsx", fixture, kind],
        { encoding: "utf8" },
      ),
    );
    const expected = { tool: 2000, assistant: 4000, child: 2001 }[kind]!;
    expect(result.rows).toBe(expected);
    expect(result.unique).toBe(expected);
    expect(result.retained).toBeLessThan(16 * 1024 * 1024);
  },
  30_000,
);
