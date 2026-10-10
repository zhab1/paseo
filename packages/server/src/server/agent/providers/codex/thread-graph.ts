import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/** Read the same edge inventory that native recovery uses, without optional thread metadata. */
export function readCodexDescendantIds(
  sqliteHome: unknown,
  threadId: string,
  userAgent: unknown,
): string[] | null {
  // Native thread/list joins optional metadata and can silently omit saved children.
  // Codex exposes no graph-only RPC. Bind this read-only query to the inspected release;
  // unknown releases must recover normally rather than consult an obsolete database.
  if (
    typeof sqliteHome !== "string" ||
    !path.isAbsolute(sqliteHome) ||
    typeof userAgent !== "string" ||
    !/^[^/]+\/0\.160\.0(?:\s|$)/.test(userAgent)
  ) {
    return null;
  }
  const db = new DatabaseSync(path.join(sqliteHome, "state_5.sqlite"), { readOnly: true });
  try {
    const children = db.prepare(
      "SELECT child_thread_id AS id FROM thread_spawn_edges WHERE parent_thread_id = ? LIMIT ?",
    );
    const pending = [threadId];
    const seen = new Set(pending);
    // Bound each indexed read as well as the queue. A recursive SQL LIMIT only
    // bounds emitted rows; its internal queue can still materialize a wide tree.
    for (let index = 0; index < pending.length; index++) {
      for (const row of children.all(pending[index], 102 - pending.length)) {
        if (typeof row.id !== "string" || !row.id || seen.has(row.id) || pending.length === 101)
          return null;
        seen.add(row.id);
        pending.push(row.id);
      }
    }
    return pending.slice(1);
  } finally {
    db.close();
  }
}
