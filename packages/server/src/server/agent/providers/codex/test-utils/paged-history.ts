type RecordValue = Record<string, unknown>;
type Request = (method: string, params?: unknown) => Promise<unknown>;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" ? (value as RecordValue) : {};
}

/** Serve existing history fixtures through the native metadata/turn/item page protocol. */
export function pagedHistoryRequest(request: Request): Request {
  const saved = new Map<string, RecordValue[]>();
  return async (method, params) => {
    const input = record(params);
    const threadId = String(input.threadId);
    if (method === "thread/read" && input.includeTurns === false) {
      const response = record(await request(method, params));
      const thread = record(response.thread);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      saved.set(
        threadId,
        turns.map((turn, index) =>
          Object.assign({}, record(turn), {
            id: record(turn).id ?? `fixture-turn-${index}`,
          }),
        ),
      );
      return { ...response, thread: { ...thread, turns: [] } };
    }
    const turns = saved.get(threadId);
    if (turns && method === "thread/turns/list") {
      const start = Number(input.cursor ?? 0);
      const end = start + Number(input.limit ?? 100);
      return {
        data: (input.sortDirection === "desc" ? turns.toReversed() : turns)
          .slice(start, end)
          .map((turn) =>
            Object.assign({}, turn, {
              items: input.itemsView === "full" ? (turn.items ?? []) : [],
            }),
          ),
        nextCursor: end < turns.length ? String(end) : null,
      };
    }
    if (turns && method === "thread/items/list") {
      const items = turns
        .filter((turn) => !input.turnId || turn.id === input.turnId)
        .flatMap((turn) =>
          (Array.isArray(turn.items) ? turn.items : []).map((item) => ({
            turnId: turn.id,
            item,
            startedAtMs: null,
            completedAtMs: null,
          })),
        );
      if (input.sortDirection === "desc") items.reverse();
      const start = Number(input.cursor ?? 0);
      const end = start + Number(input.limit ?? 40);
      return { data: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
    }
    return request(method, params);
  };
}
