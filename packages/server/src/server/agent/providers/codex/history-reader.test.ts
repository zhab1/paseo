import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerRpcError } from "./app-server-transport.js";
import { openCodexHistory } from "./history-reader.js";

describe("native paged history", () => {
  test.each([undefined, "old"])(
    "restores legacy turn pages through %s without item-store support",
    async (boundary) => {
      const client = {
        async request(method: string, params: Record<string, unknown>) {
          if (method === "thread/read") return { thread: { historyMode: "legacy" } };
          expect(method).toBe("thread/turns/list");
          if (params.itemsView === "notLoaded")
            return { data: [{ id: "old" }, { id: "new" }], nextCursor: null };
          expect(params.limit).toBe(1);
          expect(params.itemsView).toBe("full");
          const id = params.cursor ? "old" : "new";
          return {
            data: [{ id, items: [{ id: `${id}-item` }] }],
            nextCursor: params.cursor ? null : "next",
          };
        },
      };
      const history = await openCodexHistory(client, "legacy-thread", boundary);
      const items = [];
      for await (const entry of history.items) items.push(entry.item);
      expect(items).toEqual(
        boundary ? [{ id: "old-item" }] : [{ id: "new-item" }, { id: "old-item" }],
      );
      expect(history.turns.every((turn) => turn.items === undefined)).toBe(true);
    },
  );

  test("continues within a large legacy turn without dropping or duplicating older items", async () => {
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") return { thread: { historyMode: "legacy" } };
        return {
          data: [
            {
              id: "turn",
              ...(params.itemsView === "full"
                ? {
                    items: Array.from({ length: 450 }, (_, id) => ({ id })),
                  }
                : {}),
            },
          ],
          nextCursor: null,
        };
      },
    };
    const ids: number[] = [];
    let cursor;
    do {
      const history = await openCodexHistory(client, "legacy", undefined, cursor);
      let count = 0;
      for await (const entry of history.items) {
        ids.push((entry.item as { id: number }).id);
        count++;
      }
      expect(count).toBeLessThanOrEqual(200);
      cursor = history.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(Array.from({ length: 450 }, (_, i) => 449 - i));
  });

  test("keeps turns created after the initial metadata page instead of dropping their history", async () => {
    let turnReads = 0;
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list")
          return {
            data: (++turnReads === 1 ? ["old"] : ["old", "new"]).map((id) => ({
              id,
              status: "completed",
            })),
            nextCursor: null,
          };
        return {
          data: [
            {
              turnId: params.cursor ? "new" : "old",
              item: { id: params.cursor ? "new-message" : "old-message" },
            },
          ],
          nextCursor: params.cursor ? null : "next",
        };
      },
    };
    const history = await openCodexHistory(client, "root");
    const items = [];
    for await (const entry of history.items) items.push([entry.item, entry.turn.id]);
    expect(items).toEqual([
      [{ id: "old-message" }, "old"],
      [{ id: "new-message" }, "new"],
    ]);
    expect(history.turns.at(-1)?.id).toBe("new");
  });
  test.each(["thread/turns/list", "thread/items/list"])(
    "reports the required Codex upgrade when %s is unavailable",
    async (missingMethod) => {
      const client = {
        async request(method: string) {
          if (method === missingMethod)
            throw new CodexAppServerRpcError("Method not found", -32601, null);
          if (method === "thread/read") return { thread: {} };
          return { data: [{ id: "old" }], nextCursor: null };
        },
      };
      await expect(
        (async () => {
          const history = await openCodexHistory(client, "root");
          for await (const _ of history.items) {
            /* consume */
          }
        })(),
      ).rejects.toThrow("Codex CLI 0.153.4 or newer");
    },
  );

  test.each(["shell", "mcp"])(
    "releases oversized %s outputs before retaining the restored timeline",
    (kind) => {
      const fixture = fileURLToPath(
        new URL("./test-utils/history-memory-repro.ts", import.meta.url),
      );
      const result = JSON.parse(
        execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture, "", kind], {
          encoding: "utf8",
        }),
      );
      expect(result.rows).toBe(200);
      expect(result.firstCallId).toBe(`${kind === "mcp" ? "mcp" : "command"}-200`);
      expect(result.lastCallId).toBe(`${kind === "mcp" ? "mcp" : "command"}-399`);
      expect(result.maxOutput).toBe(64 * 1024);
      // The older half is never read; retained output is capped before reversing the tail.
      expect(result.retained).toBeLessThan(64 * 1024 * 1024);
    },
    30_000,
  );
  test("reads bounded item pages, retaining turn identity without requiring lifecycle timestamps", async () => {
    let itemRequests = 0;
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") {
          expect(params.includeTurns).toBe(false);
          return { thread: { path: null } };
        }
        if (method === "thread/turns/list") {
          expect(params.itemsView).toBe("notLoaded");
          return { data: [{ id: "turn", status: "completed" }], nextCursor: null };
        }
        expect(method).toBe("thread/items/list");
        expect(params.limit).toBe(40);
        const page = itemRequests++;
        expect(params.cursor).toBe(page ? "next" : undefined);
        return {
          data: [
            {
              turnId: "turn",
              item: { id: `item-${page}` },
            },
          ],
          nextCursor: page ? null : "next",
        };
      },
    };
    const history = await openCodexHistory(client, "root");
    expect(itemRequests).toBe(0);
    const items = [];
    for await (const item of history.items) items.push(item);
    expect(items.map((entry) => [entry.item, entry.turn.id])).toEqual([
      [{ id: "item-0" }, "turn"],
      [{ id: "item-1" }, "turn"],
    ]);
    expect(itemRequests).toBe(2);
  });

  test("freezes a deferred child at its completed turn and rejects a missing boundary", async () => {
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list")
          return {
            data: [
              { id: "old", status: "completed" },
              { id: "new", status: "inProgress" },
            ],
            nextCursor: null,
          };
        return {
          data: [String(params.turnId)].map((turnId) => ({
            turnId,
            item: { id: turnId },
            startedAtMs: null,
            completedAtMs: null,
          })),
          nextCursor: null,
        };
      },
    };
    const history = await openCodexHistory(client, "child", "old");
    const items = [];
    for await (const item of history.items) items.push(item.item);
    expect(items).toEqual([{ id: "old" }]);
    expect(history.turns.at(-1)?.status).toBe("completed");
    await expect(openCodexHistory(client, "child", "missing")).rejects.toThrow(
      "no longer available",
    );
  });

  test("propagates a later page failure instead of publishing truncated history", async () => {
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") return { data: [{ id: "turn" }], nextCursor: null };
        if (params.cursor) throw new Error("history unavailable");
        return { data: [], nextCursor: "next" };
      },
    };
    const history = await openCodexHistory(client, "root");
    await expect(history.items.next()).rejects.toThrow("history unavailable");
  });
  test("opens the latest native page and continues older history without duplicates", async () => {
    let pages = 0;
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") return { data: [{ id: "turn" }], nextCursor: null };
        expect(params.sortDirection).toBe("desc");
        const offset = Number(params.cursor ?? 0);
        const limit = Number(params.limit);
        expect(limit).toBeLessThanOrEqual(40);
        pages++;
        return {
          data: Array.from({ length: limit }, (_, index) => ({
            turnId: "turn",
            item: { id: `item-${10300 - offset - index}` },
            startedAtMs: 1791380000000,
            completedAtMs: 1791380000123,
          })),
          nextCursor: String(offset + limit),
        };
      },
    };
    const history = await openCodexHistory(client, "root");
    const items = [];
    for await (const entry of history.items) items.push(entry);
    expect(items).toHaveLength(200);
    expect(items[0]).toMatchObject({ item: { id: "item-10300" }, startedAtMs: 1791380000000 });
    expect(items.at(-1)?.item).toEqual({ id: "item-10101" });
    expect(pages).toBe(5);
    expect(history.nextCursor).toEqual({ nativeCursor: "200", turnIndex: 0 });
    const older = await openCodexHistory(client, "root", undefined, history.nextCursor!);
    const oldItems = [];
    for await (const entry of older.items) oldItems.push(entry.item);
    expect(oldItems).toHaveLength(200);
    expect(oldItems[0]).toEqual({ id: "item-10100" });
    expect(oldItems.at(-1)).toEqual({ id: "item-9901" });
    expect(pages).toBe(10);
  });
});
