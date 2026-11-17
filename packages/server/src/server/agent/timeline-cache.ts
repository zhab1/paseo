import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import { continuesTimelineTurn, isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
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
        turn_id TEXT,
        turn_trigger INTEGER NOT NULL,
        ranges TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (timeline, start)
      );
      CREATE INDEX timeline_identity ON timeline_rows(timeline, identity, start);
      CREATE INDEX timeline_client_message ON timeline_rows(timeline, client_message_id);
      CREATE INDEX timeline_assistant_message ON timeline_rows(timeline, assistant_message_id, start);
      CREATE INDEX timeline_item_type ON timeline_rows(timeline, item_type, start);
      CREATE INDEX timeline_end ON timeline_rows(timeline, end, start);
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
      (timeline, start, end, identity, client_message_id, assistant_message_id, item_type, turn_id, turn_trigger, ranges, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        this.key,
        row.seqStart,
        row.seqEnd,
        timelineItemIdentity(item),
        item.type === "user_message" ? (item.clientMessageId ?? null) : null,
        item.type === "assistant_message" ? (item.messageId ?? null) : null,
        item.type,
        row.turnId ?? null,
        isTimelineTurnTrigger(item) ? 1 : 0,
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
    const identities = [
      ...new Set(
        rows.flatMap(({ item }) => {
          const identity = timelineItemIdentity(item);
          return identity === null ? [] : [identity];
        }),
      ),
    ];
    // An older lifecycle item can match a later card beyond the first row.
    // Read only those identities plus the adjacent text boundary.
    const prior = this.read(
      `SELECT value FROM timeline_rows WHERE timeline = ? AND
        (start = (SELECT min(start) FROM timeline_rows WHERE timeline = ?)
         ${identities.length ? `OR identity IN (${identities.map(() => "?").join(",")})` : ""})
        ORDER BY start`,
      this.key,
      ...identities,
    );
    const projection = new TimelineProjection();
    for (const row of rows) projection.append(row);
    for (const row of prior) {
      projection.append(row);
      this.cache.db
        .prepare("DELETE FROM timeline_rows WHERE timeline = ? AND start = ?")
        .run(this.key, row.seqStart);
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
    wholeTurns?: boolean;
  }) {
    const backwards = options.direction !== "after";
    const limit = Math.max(0, Math.floor(options.limit));
    let boundary = options.bounds.maxSeq;
    if (options.direction === "before")
      boundary = Math.min(boundary, (options.cursorSeq ?? boundary + 1) - 1);
    else if (options.direction === "after")
      boundary = options.cursorSeq ?? options.bounds.minSeq - 1;
    // Backward pages need only one extra anchor to establish hasOlder. Forward
    // catch-up must also consider old cards whose later lifecycle updates cross the cursor.
    const metadata = this.cache.db
      .prepare(
        `SELECT start, end, ranges FROM timeline_rows WHERE timeline = ? AND
         ${backwards ? "start <=" : "end >"} ? ORDER BY start ${backwards ? "DESC" : "ASC"}
         ${backwards && limit > 0 ? "LIMIT ?" : ""}`,
      )
      .all(this.key, boundary, ...(backwards && limit > 0 ? [limit + 1] : []))
      .map((row) => ({
        seqStart: Number(row.start),
        seqEnd: Number(row.end),
        sourceSeqRanges: JSON.parse(String(row.ranges)) as TimelineSeqRange[],
      }));
    if (backwards) metadata.reverse();
    let selected = selectProjectedEntriesPage({ ...options, entries: metadata });
    if (options.wholeTurns && backwards && selected.startSeq !== null) {
      let start = selected.startSeq;
      const rowAt = (seq: number) =>
        this.cache.db
          .prepare(
            "SELECT start, turn_id, turn_trigger FROM timeline_rows WHERE timeline = ? AND start = ?",
          )
          .get(this.key, seq)!;
      for (;;) {
        const overlapping = this.cache.db
          .prepare(
            "SELECT min(start) AS first FROM timeline_rows WHERE timeline = ? AND start < ? AND end >= ?",
          )
          .get(this.key, start, start);
        if (overlapping?.first !== null && overlapping?.first !== undefined) {
          start = Number(overlapping.first);
          continue;
        }
        const current = rowAt(start);
        const previous = this.cache.db
          .prepare(
            "SELECT start, turn_id FROM timeline_rows WHERE timeline = ? AND start < ? ORDER BY start DESC LIMIT 1",
          )
          .get(this.key, start);
        if (
          !previous ||
          !continuesTimelineTurn(
            typeof previous.turn_id === "string" ? previous.turn_id : undefined,
            typeof current.turn_id === "string" ? current.turn_id : undefined,
            Number(current.turn_trigger) === 1,
          )
        )
          break;
        start = Number(previous.start);
      }
      let last = selected.entries.at(-1)!.seqStart;
      if (options.direction === "before") {
        for (;;) {
          const current = rowAt(last);
          const next = this.cache.db
            .prepare(
              "SELECT start, turn_id, turn_trigger FROM timeline_rows WHERE timeline = ? AND start > ? ORDER BY start LIMIT 1",
            )
            .get(this.key, last);
          if (
            !next ||
            !continuesTimelineTurn(
              typeof current.turn_id === "string" ? current.turn_id : undefined,
              typeof next.turn_id === "string" ? next.turn_id : undefined,
              Number(next.turn_trigger) === 1,
            )
          )
            break;
          last = Number(next.start);
        }
      }
      const following = this.cache.db
        .prepare(
          "SELECT start FROM timeline_rows WHERE timeline = ? AND start > ? ORDER BY start LIMIT 1",
        )
        .get(this.key, last);
      const endSeq = following ? Number(following.start) - 1 : options.bounds.maxSeq;
      const entries = this.cache.db
        .prepare(
          "SELECT start, end, ranges FROM timeline_rows WHERE timeline = ? AND start >= ? AND start <= ? ORDER BY start",
        )
        .all(this.key, start, last)
        .map((row) => ({
          seqStart: Number(row.start),
          seqEnd: Number(row.end),
          sourceSeqRanges: JSON.parse(String(row.ranges)) as TimelineSeqRange[],
        }));
      selected = {
        entries,
        startSeq: start,
        endSeq,
        hasOlder: !!this.cache.db
          .prepare("SELECT 1 FROM timeline_rows WHERE timeline = ? AND start < ? LIMIT 1")
          .get(this.key, start),
        hasNewer: endSeq < options.bounds.maxSeq,
      };
    }
    if (!options.wholeTurns && options.direction === "tail" && selected.startSeq !== null) {
      selected.reset = !!this.cache.db
        .prepare(
          "SELECT 1 FROM timeline_rows WHERE timeline = ? AND end >= ? AND start < ? LIMIT 1",
        )
        .get(this.key, selected.startSeq, selected.startSeq);
    }
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
