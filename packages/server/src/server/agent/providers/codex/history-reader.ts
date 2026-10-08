import { z } from "zod";
import { AGENT_TIMELINE_ITEM_LIMIT } from "../../agent-timeline-content.js";
import { resolveCreateAgentTitles } from "../../create-agent-title.js";
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
      startedAtMs: z.number().nullable().optional(),
      completedAtMs: z.number().nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const MetadataSchema = z.object({
  thread: z.object({
    path: z.string().nullable().optional(),
    historyMode: z.string().optional(),
    name: z.string().nullable().optional(),
    preview: z.string().optional(),
  }),
});
const PAGE_SIZE = 40;

export const CodexHistoryCursorSchema = z.object({
  nativeCursor: z.string().nullable(),
  turnIndex: z.number().int().nonnegative(),
  legacyItemIndex: z.number().int().nonnegative().optional(),
});
export type CodexHistoryCursor = z.infer<typeof CodexHistoryCursorSchema>;

/** Read native pages without retaining the full, unbounded tool-output response. */
export async function openCodexHistory(
  client: HistoryClient,
  threadId: string,
  throughTurnId?: string,
  resume?: CodexHistoryCursor,
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

  let nextCursor: CodexHistoryCursor | null = null;
  // Newest first so reopening does not read every page of a saved conversation.
  // The caller projects/caps each item before reversing this bounded window.
  async function* legacyItems() {
    let remaining = AGENT_TIMELINE_ITEM_LIMIT;
    let cursor: string | null = resume?.nativeCursor ?? null;
    let reachedBoundary = !throughTurnId || resume !== undefined;
    let itemIndex = resume?.legacyItemIndex;
    do {
      const page = TurnsPageSchema.parse(
        await requestPage("thread/turns/list", {
          threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const rawTurn of page.data) {
        const { items: turnItems, ...turn } = TurnSchema.extend({
          items: z.array(z.unknown()),
        }).parse(rawTurn);
        if (turn.id === throughTurnId) reachedBoundary = true;
        if (!reachedBoundary) continue;
        turns.set(turn.id, turn);
        for (let index = itemIndex ?? turnItems.length - 1; index >= 0; index--) {
          yield { turnId: turn.id, item: turnItems[index], turn };
          if (--remaining === 0) {
            nextCursor = page.nextCursor ? { nativeCursor: page.nextCursor, turnIndex: 0 } : null;
            nextCursor =
              index > 0
                ? { nativeCursor: cursor, turnIndex: 0, legacyItemIndex: index - 1 }
                : nextCursor;
            return;
          }
        }
        itemIndex = undefined;
      }
      if (page.nextCursor && page.nextCursor === cursor)
        throw new Error("Codex turn cursor did not advance");
      cursor = page.nextCursor;
    } while (cursor);
    return;
  }

  async function resolveTurn(turnId: string) {
    if (!turns.has(turnId)) await readTurns();
    const turn = turns.get(turnId);
    if (!turn) throw new Error("Codex history turn is no longer available");
    return turn;
  }

  async function* pagedItems() {
    let remaining = AGENT_TIMELINE_ITEM_LIMIT;
    // A deferred child is frozen at its saved completed turn. Native turn filters
    // avoid paging through any newer turns, which belong to another observation.
    const turnIds = throughTurnId ? [...turns.keys()].toReversed() : [undefined];
    for (let turnIndex = resume?.turnIndex ?? 0; turnIndex < turnIds.length; turnIndex++) {
      const turnId = turnIds[turnIndex];
      let cursor: string | null =
        turnIndex === (resume?.turnIndex ?? 0) ? (resume?.nativeCursor ?? null) : null;
      do {
        const page = ItemsPageSchema.parse(
          await requestPage("thread/items/list", {
            threadId,
            ...(turnId ? { turnId } : {}),
            limit: Math.min(PAGE_SIZE, remaining),
            sortDirection: "desc",
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const entry of page.data) {
          const turn = await resolveTurn(entry.turnId);
          yield { ...entry, turn };
          if (--remaining === 0) {
            nextCursor =
              turnIndex + 1 < turnIds.length
                ? { nativeCursor: null, turnIndex: turnIndex + 1 }
                : null;
            nextCursor = page.nextCursor
              ? { nativeCursor: page.nextCursor, turnIndex }
              : nextCursor;
            return;
          }
        }
        if (page.nextCursor && page.nextCursor === cursor)
          throw new Error("Codex item cursor did not advance");
        cursor = page.nextCursor;
      } while (cursor);
    }
  }
  return {
    path: metadata.thread.path,
    title:
      resolveCreateAgentTitles({
        configTitle: metadata.thread.name,
        initialPrompt: metadata.thread.preview,
      }).provisionalTitle ?? undefined,
    get nextCursor() {
      return nextCursor;
    },
    get turns() {
      return [...turns.values()];
    },
    items: metadata.thread.historyMode === "legacy" ? legacyItems() : pagedItems(),
  };
}
