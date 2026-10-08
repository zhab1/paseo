import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  TimelineProjection,
  selectProjectedEntriesPage,
  type ProjectedTimelineRow,
  type TimelineSeqRange,
  type TimelineLimitDirection,
} from "./timeline-projection.js";

/** Disposable projection cache. Native provider histories remain the source of truth. */
export class TimelineCache {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // No cache data survives a worker. Recreate even an interrupted/corrupt file.
    rmSync(path, { force: true });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    // A worker owns this cache; epochs and projections are rebuilt after restart.
    this.db.exec(`
      PRAGMA cache_size = -1024;
      PRAGMA journal_mode = MEMORY;
      PRAGMA synchronous = OFF;
      CREATE TABLE timeline_rows (
        timeline TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        identity TEXT,
        client_message_id TEXT,
        assistant_message_id TEXT,
        item_type TEXT NOT NULL,
        ranges TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (timeline, start)
      );
      CREATE INDEX timeline_identity ON timeline_rows(timeline, identity, start);
      CREATE INDEX timeline_client_message ON timeline_rows(timeline, client_message_id);
      CREATE INDEX timeline_assistant_message ON timeline_rows(timeline, assistant_message_id, start);
      CREATE INDEX timeline_item_type ON timeline_rows(timeline, item_type, start);
      CREATE INDEX timeline_end ON timeline_rows(timeline, end);
    `);
  }

  delete(timeline: string): void {
    this.db.prepare("DELETE FROM timeline_rows WHERE timeline = ?").run(timeline);
  }

  close(): void {
    this.db.close();
  }
}

/** Uses the same projection rules as memory storage, loading only rows an update can merge. */
export class CachedTimelineProjection {
  constructor(
    private readonly cache: TimelineCache,
    private readonly key: string,
  ) {}

  private read(sql: string, ...params: (string | number)[]): ProjectedTimelineRow[] {
    return this.cache.db
      .prepare(sql)
      .all(this.key, ...params)
      .map((row) => JSON.parse(String(row.value)) as ProjectedTimelineRow);
  }

  private save(row: ProjectedTimelineRow): void {
    const item = row.item;
    this.cache.db
      .prepare(`INSERT OR REPLACE INTO timeline_rows
      (timeline, start, end, identity, client_message_id, assistant_message_id, item_type, ranges, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        this.key,
        row.seqStart,
        row.seqEnd,
        timelineItemIdentity(item),
        item.type === "user_message" ? (item.clientMessageId ?? null) : null,
        item.type === "assistant_message" ? (item.messageId ?? null) : null,
        item.type,
        JSON.stringify(row.sourceSeqRanges),
        JSON.stringify(row),
      );
  }

  append(row: AgentTimelineRow): void {
    // Only tools/plugin items merge across intervening rows. Assistant fragments
    // with the same messageId can span a long turn and must not all be reloaded.
    const identity =
      row.item.type === "tool_call" || row.item.type === "plugin"
        ? timelineItemIdentity(row.item)
        : null;
    const prior = this.read(
      `SELECT value FROM timeline_rows WHERE timeline = ? AND
        (start = (SELECT max(start) FROM timeline_rows WHERE timeline = ?) OR
         start = (SELECT max(start) FROM timeline_rows WHERE timeline = ? AND identity = ?))
        ORDER BY start`,
      this.key,
      this.key,
      identity ?? "",
    );
    const projection = new TimelineProjection();
    for (const previous of prior) projection.append(previous);
    projection.append(row);
    for (const projected of projection.getRows()) this.save(projected);
  }

  prepend(rows: readonly AgentTimelineRow[]): void {
    const boundary = this.read(
      "SELECT value FROM timeline_rows WHERE timeline = ? ORDER BY start LIMIT 1",
    )[0];
    const projection = new TimelineProjection();
    for (const row of rows) projection.append(row);
    if (boundary) {
      projection.append(boundary);
      this.cache.db
        .prepare("DELETE FROM timeline_rows WHERE timeline = ? AND start = ?")
        .run(this.key, boundary.seqStart);
    }
    for (const row of projection.getRows()) this.save(row);
  }

  get size(): number {
    return Number(
      this.cache.db
        .prepare("SELECT count(*) AS n FROM timeline_rows WHERE timeline = ?")
        .get(this.key)?.n,
    );
  }

  getRows(): ProjectedTimelineRow[] {
    return this.read("SELECT value FROM timeline_rows WHERE timeline = ? ORDER BY start");
  }

  getLastItem(type?: string): ProjectedTimelineRow | null {
    return (
      (type
        ? this.read(
            "SELECT value FROM timeline_rows WHERE timeline = ? AND item_type = ? ORDER BY start DESC LIMIT 1",
            type,
          )
        : this.read(
            "SELECT value FROM timeline_rows WHERE timeline = ? ORDER BY end DESC LIMIT 1",
          ))[0] ?? null
    );
  }

  getSubmittedUserMessage(clientMessageId: string): ProjectedTimelineRow | null {
    return (
      this.read(
        "SELECT value FROM timeline_rows WHERE timeline = ? AND client_message_id = ? ORDER BY start LIMIT 1",
        clientMessageId,
      )[0] ?? null
    );
  }

  enrichSubmittedUserMessage(
    clientMessageId: string,
    providerMessageId: string,
  ): ProjectedTimelineRow | null {
    const row = this.getSubmittedUserMessage(clientMessageId);
    if (!row) return null;
    const enriched = { ...row, providerMessageId };
    this.save(enriched);
    return enriched;
  }

  selectPage(options: {
    bounds: { minSeq: number; maxSeq: number };
    direction: TimelineLimitDirection;
    cursorSeq?: number;
    limit: number;
  }) {
    const metadata = this.cache.db
      .prepare("SELECT start, end, ranges FROM timeline_rows WHERE timeline = ? ORDER BY start")
      .all(this.key)
      .map((row) => ({
        seqStart: Number(row.start),
        seqEnd: Number(row.end),
        sourceSeqRanges: JSON.parse(String(row.ranges)) as TimelineSeqRange[],
      }));
    const selected = selectProjectedEntriesPage({ ...options, entries: metadata });
    const entries = selected.entries.map(
      (row) =>
        this.read(
          "SELECT value FROM timeline_rows WHERE timeline = ? AND start = ?",
          row.seqStart,
        )[0]!,
    );
    const selectedAnchors = new Set(entries.map((entry) => entry.seqStart));
    const priorAssistantMessageIds = entries.flatMap(({ item }) => {
      if (item.type !== "assistant_message" || !item.messageId || selected.startSeq === null)
        return [];
      return this.cache.db
        .prepare(
          "SELECT start FROM timeline_rows WHERE timeline = ? AND start < ? AND assistant_message_id = ?",
        )
        .all(this.key, selected.startSeq, item.messageId)
        .some((row) => !selectedAnchors.has(Number(row.start)))
        ? [item.messageId]
        : [];
    });
    return { ...selected, entries, priorAssistantMessageIds };
  }
}
