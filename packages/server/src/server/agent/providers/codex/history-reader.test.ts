import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerRpcError } from "./app-server-transport.js";
import { openCodexHistory } from "./history-reader.js";

describe("native paged history", () => {
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
      expect(result.rows).toBe(400);
      expect(result.maxOutput).toBe(64 * 1024);
      // 200 MiB of native outputs must not remain behind a 25 MiB UI projection.
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
