import { z } from "zod";

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
  const turns = new Map<string, z.infer<typeof TurnSchema>>();
  let cursor: string | null = null;
  do {
    const page = TurnsPageSchema.parse(
      await client.request("thread/turns/list", {
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
  if (throughTurnId && !turns.has(throughTurnId)) {
    throw new Error("Saved Codex child turn is no longer available");
  }

  async function* items() {
    let itemCursor: string | null = null;
    do {
      const page = ItemsPageSchema.parse(
        await client.request("thread/items/list", {
          threadId,
          limit: PAGE_SIZE,
          sortDirection: "asc",
          ...(itemCursor ? { cursor: itemCursor } : {}),
        }),
      );
      for (const entry of page.data) {
        const turn = turns.get(entry.turnId);
        // Turns created after the metadata snapshot belong to live notifications.
        if (!turn) return;
        yield { ...entry, turn };
      }
      if (page.nextCursor && page.nextCursor === itemCursor)
        throw new Error("Codex item cursor did not advance");
      itemCursor = page.nextCursor;
    } while (itemCursor);
  }
  return { path: metadata.thread.path, turns: [...turns.values()], items: items() };
}
