import { CachedTimelineProjection, type TimelineCache } from "./timeline-cache.js";
import { randomUUID } from "node:crypto";
import {
  TimelineProjection,
  projectTimelineRows,
  selectProjectedTimelinePage,
  type ProjectedTimelineRow,
  type ProjectedTimelinePageSelection,
} from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection | CachedTimelineProjection;
  minSeq: number;
  nextSeq: number;
  historySnapshots?: Set<AgentTimelineRow[][]>;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
// Leave stable positive cursor positions for native history fetched backwards.
export const PAGED_HISTORY_ORIGIN = 2 ** 40;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

function getPriorAssistantMessageIds(
  rows: readonly ProjectedTimelineRow[],
  page: ProjectedTimelinePageSelection,
): string[] {
  const pageMessageIds = new Set(
    page.entries.flatMap(({ item }) =>
      item.type === "assistant_message" && item.messageId ? [item.messageId] : [],
    ),
  );
  const priorAssistantMessageIds = new Set<string>();
  const selectedAnchors = new Set(page.entries.map((entry) => entry.seqStart));
  for (const row of rows) {
    if (page.startSeq === null || row.seqStart >= page.startSeq) break;
    if (
      row.item.type === "assistant_message" &&
      row.item.messageId &&
      pageMessageIds.has(row.item.messageId) &&
      !selectedAnchors.has(row.seqStart)
    )
      priorAssistantMessageIds.add(row.item.messageId);
  }
  return [...priorAssistantMessageIds];
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();
  private readonly historyLoads = new Map<string, Promise<void>>();

  constructor(private readonly cache?: TimelineCache) {}

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    this.delete(agentId);
    const epoch = options?.epoch ?? randomUUID();
    const projection = this.cache
      ? new CachedTimelineProjection(this.cache, `${agentId}:${epoch}`)
      : new TimelineProjection();
    for (const row of rows) projection.append(row);
    this.states.set(agentId, {
      epoch,
      projection,
      minSeq: projection.getRows()[0]?.seqStart ?? (nextSeq > 1 ? nextSeq : 0),
      nextSeq,
    });
  }

  delete(agentId: string): void {
    const state = this.states.get(agentId);
    if (state) this.cache?.delete(`${agentId}:${state.epoch}`);
    this.states.delete(agentId);
    this.historyLoads.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  async getSnapshot(
    agentId: string,
    loadHistory: () => Promise<unknown>,
  ): Promise<AgentTimelineItem[]> {
    const state = this.requireState(agentId);
    const current = structuredClone(this.getRows(agentId));
    const older: AgentTimelineRow[][] = [];
    state.historySnapshots ??= new Set();
    state.historySnapshots.add(older);
    try {
      await loadHistory();
      if (this.states.get(agentId) !== state) throw new Error("Agent history was reloaded");
      return projectTimelineRows({
        rows: [...older.toReversed().flat(), ...current],
        mode: "projected",
      }).map((row) => row.item);
    } finally {
      state.historySnapshots.delete(older);
    }
  }

  getItemCount(agentId: string): number {
    const projection = this.requireState(agentId).projection;
    return projection instanceof CachedTimelineProjection
      ? projection.size
      : projection.getRows().length;
  }

  prepend(
    agentId: string,
    items: readonly { item: AgentTimelineItem; timestamp?: string }[],
  ): void {
    if (!items.length) return;
    const state = this.requireState(agentId);
    const startSeq = state.minSeq - items.length;
    if (startSeq < 1) throw new Error("History cursor space exhausted");
    const rows = items.map((entry, index) => ({
      seq: startSeq + index,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      item: entry.item,
    }));
    if (state.projection instanceof CachedTimelineProjection) {
      state.projection.prepend(rows);
    } else {
      const projection = new TimelineProjection();
      for (const row of [...rows, ...state.projection.getRows()]) projection.append(row);
      state.projection = projection;
    }
    state.minSeq = startSeq;
    // A complete turn snapshot accepts older history, including an in-flight
    // scroll, but never live updates after its boundary. Keep the native rows
    // before projection can merge them with a following turn's newer values.
    for (const snapshot of state.historySnapshots ?? []) snapshot.push(structuredClone(rows));
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const projection = this.requireState(agentId).projection;
    if (projection instanceof CachedTimelineProjection)
      return projection.getSubmittedUserMessage(clientMessageId);
    const row = projection
      .getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId === clientMessageId,
      );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const rows =
      state.projection instanceof CachedTimelineProjection ? null : state.projection.getRows();
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      state.minSeq > 0 &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const selection = {
      bounds: window,
      direction: reset ? ("tail" as const) : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    };
    const page =
      state.projection instanceof CachedTimelineProjection
        ? state.projection.selectPage(selection)
        : selectProjectedTimelinePage({ ...selection, rows: rows! });
    return {
      epoch: state.epoch,
      direction,
      reset: reset || page.reset === true,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      priorAssistantMessageIds:
        "priorAssistantMessageIds" in page
          ? (page.priorAssistantMessageIds as string[])
          : getPriorAssistantMessageIds(rows!, page),
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  async fetchPage(
    agentId: string,
    options: AgentTimelineFetchOptions | undefined,
    history: {
      hasOlder(): boolean;
      loadOlder(): Promise<readonly { item: AgentTimelineItem; timestamp?: string }[]>;
    },
  ): Promise<AgentTimelineFetchResult> {
    const state = this.requireState(agentId);
    const limit = options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT;
    // A complete snapshot is an explicit consumer request. While fetching its
    // older pages, inspect only a bounded window instead of copying all rows
    // after every prepend; materialize the full result once at the end.
    const windowOptions = limit === 0 ? { ...options, limit: 1 } : options;
    let page = this.fetch(agentId, windowOptions);
    while (!page.staleCursor && history.hasOlder()) {
      // Native pages can project to fewer rows. Return available rows immediately;
      // filling the display limit here can replay the entire remaining history.
      if (options?.direction === "after" || (limit > 0 && page.rows.length > 0)) break;
      let pending = this.historyLoads.get(agentId);
      if (!pending) {
        pending = Promise.resolve().then(async () => {
          const entries = await history.loadOlder();
          if (this.states.get(agentId) !== state) throw new Error("Agent history was reloaded");
          this.prepend(agentId, entries);
          return undefined;
        });
        this.historyLoads.set(agentId, pending);
      }
      try {
        await pending;
      } finally {
        if (this.historyLoads.get(agentId) === pending) this.historyLoads.delete(agentId);
      }
      page = this.fetch(agentId, windowOptions);
    }
    if (limit === 0) page = this.fetch(agentId, options);
    return { ...page, hasOlder: page.hasOlder || history.hasOlder() };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    if (state.projection instanceof CachedTimelineProjection) {
      const row = state.projection.getLastItem();
      return row?.seqEnd === state.nextSeq - 1 ? row.item : null;
    }
    return state.projection.getRows().find((row) => row.seqEnd === state.nextSeq - 1)?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const projection = this.requireState(agentId).projection;
    if (projection instanceof CachedTimelineProjection) {
      const item = projection.getLastItem("assistant_message")?.item;
      return item?.type === "assistant_message" ? item.text : null;
    }
    const row = this.requireState(agentId)
      .projection.getRows()
      .findLast((candidate) => candidate.item.type === "assistant_message");
    return row?.item.type === "assistant_message" ? row.item.text : null;
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
