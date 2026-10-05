import { z } from "zod";
import { CodexAppServerRpcError } from "./app-server-transport.js";

interface HistoryClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

const TurnSchema = z.object({ id: z.string() }).passthrough();
const TurnsPageSchema = z.object({
  data: z.array(TurnSchema),
  nextCursor: z.string().nullable(),
});
const ItemsPageSchema = z.object({
  data: z.array(
    z.object({
      turnId: z.string(),
      item: z.unknown(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const MetadataSchema = z.object({
  thread: z.object({ path: z.string().nullable().optional() }),
});
const PAGE_SIZE = 40;

/** Read native pages without retaining the full, unbounded tool-output response. */
export async function openCodexHistory(
  client: HistoryClient,
  threadId: string,
  throughTurnId?: string,
) {
  const metadata = MetadataSchema.parse(
    await client.request("thread/read", {
      threadId,
      includeTurns: false,
    }),
  );
  async function requestPage(method: string, params: Record<string, unknown>) {
    try {
      return await client.request(method, params);
    } catch (error) {
      if (error instanceof CodexAppServerRpcError && error.code === -32601) {
        throw new Error(
          "History restoration requires Codex CLI 0.153.4 or newer. Update Codex and retry.",
          { cause: error },
        );
      }
      throw error;
    }
  }
  const turns = new Map<string, z.infer<typeof TurnSchema>>();
  async function readTurns() {
    let cursor: string | null = null;
    do {
      const page = TurnsPageSchema.parse(
        await requestPage("thread/turns/list", {
          threadId,
          limit: 100,
          sortDirection: "asc",
          itemsView: "notLoaded",
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const turn of page.data) {
        turns.set(turn.id, turn);
        if (turn.id === throughTurnId) break;
      }
      if (throughTurnId && turns.has(throughTurnId)) break;
      if (page.nextCursor && page.nextCursor === cursor)
        throw new Error("Codex turn cursor did not advance");
      cursor = page.nextCursor;
    } while (cursor);
  }
  await readTurns();
  if (throughTurnId && !turns.has(throughTurnId)) {
    throw new Error("Saved Codex child turn is no longer available");
  }

  async function* items() {
    let itemCursor: string | null = null;
    do {
      const page = ItemsPageSchema.parse(
        await requestPage("thread/items/list", {
          threadId,
          limit: PAGE_SIZE,
          sortDirection: "asc",
          ...(itemCursor ? { cursor: itemCursor } : {}),
        }),
      );
      for (const entry of page.data) {
        let turn = turns.get(entry.turnId);
        if (!turn) {
          if (throughTurnId) return;
          // Parent scans can encounter turns created while earlier pages loaded.
          // They must come from history: the manager may not have subscribed yet.
          await readTurns();
          turn = turns.get(entry.turnId);
          if (!turn) throw new Error("Codex history turn is no longer available");
        }
        yield { ...entry, turn };
      }
      if (page.nextCursor && page.nextCursor === itemCursor)
        throw new Error("Codex item cursor did not advance");
      itemCursor = page.nextCursor;
    } while (itemCursor);
  }
  return {
    path: metadata.thread.path,
    get turns() {
      return [...turns.values()];
    },
    items: items(),
  };
}
