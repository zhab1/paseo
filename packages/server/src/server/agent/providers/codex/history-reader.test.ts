import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openCodexHistory } from "./history-reader.js";

describe("native paged history", () => {
  test("releases oversized raw outputs before retaining the restored timeline", () => {
    const fixture = fileURLToPath(new URL("./test-utils/history-memory-repro.ts", import.meta.url));
    const result = JSON.parse(
      execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
        encoding: "utf8",
      }),
    );
    expect(result.rows).toBe(400);
    expect(result.maxOutput).toBe(64 * 1024);
    // 200 MiB of native outputs must not remain behind a 25 MiB UI projection.
    expect(result.retained).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);
  test("reads bounded item pages, retaining turn identity and timestamps", async () => {
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
              startedAtMs: 1000 + page,
              completedAtMs: null,
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
    expect(items.map((entry) => [entry.item, entry.turn.id, entry.startedAtMs])).toEqual([
      [{ id: "item-0" }, "turn", 1000],
      [{ id: "item-1" }, "turn", 1001],
    ]);
    expect(itemRequests).toBe(2);
  });

  test("freezes a deferred child at its completed turn and rejects a missing boundary", async () => {
    const client = {
      async request(method: string) {
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
          data: ["old", "new"].map((turnId) => ({
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
});
