import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readCodexDescendantIds } from "./thread-graph.js";

describe("native Codex descendant inventory", () => {
  let home: string;
  const userAgent = "codex_app_server_daemon/0.160.0 (Linux)";
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "codex-thread-graph-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function graph(edges: Array<[string, string]>) {
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      db.exec(
        "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL UNIQUE)",
      );
      db.exec("CREATE INDEX parents ON thread_spawn_edges(parent_thread_id)");
      const insert = db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)");
      for (const edge of edges) insert.run(...edge);
    } finally {
      db.close();
    }
  }

  test.each([false, true])(
    "includes nested descendants regardless of optional metadata: %s",
    (hasMetadata) => {
      graph([
        ["root", "child"],
        ["child", "grandchild"],
        ["elsewhere", "unrelated"],
      ]);
      if (hasMetadata) {
        const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
        db.exec(
          "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER); INSERT INTO threads VALUES ('child', 0), ('grandchild', 1)",
        );
        db.close();
      }
      // Both archived and unarchived children remain visible, even without their metadata rows.
      expect(readCodexDescendantIds(home, "root", userAgent)?.sort()).toEqual([
        "child",
        "grandchild",
      ]);
      expect(readCodexDescendantIds(home, "leaf", userAgent)).toEqual([]);
    },
  );

  test("bounds the whole graph and detects overflow", () => {
    graph(
      Array.from({ length: 101 }, (_, i) => [i === 0 ? "root" : `child-${i - 1}`, `child-${i}`]),
    );
    expect(readCodexDescendantIds(home, "root", userAgent)).toBeNull();
    expect(readCodexDescendantIds(home, "child-0", userAgent)).toHaveLength(100);
  });

  test("does not certify a cyclic graph", () => {
    graph([
      ["root", "child"],
      ["child", "root"],
    ]);
    expect(readCodexDescendantIds(home, "root", userAgent)).toBeNull();
  });

  test.each(["root", "nested"])("bounds wide fan-out under %s", (parent) => {
    const edges: Array<[string, string]> = parent === "nested" ? [["root", "nested"]] : [];
    for (let i = 0; i < 1_000; i++) edges.push([parent, `wide-${i}`]);
    graph(edges);
    expect(readCodexDescendantIds(home, "root", userAgent)).toBeNull();
  });

  test.each([
    undefined,
    "unrecognized",
    "client/0.159.0",
    "client/0.161.0",
    "client/0.160.0-alpha.1",
  ])("does not consult an old database for an unverified native release: %s", (version) => {
    graph([]);
    expect(readCodexDescendantIds(home, "root", version)).toBeNull();
  });

  test("does not guess unresolved paths or create missing databases", () => {
    expect(readCodexDescendantIds(null, "root", userAgent)).toBeNull();
    expect(readCodexDescendantIds("relative-home", "root", userAgent)).toBeNull();
    expect(() => readCodexDescendantIds(home, "root", userAgent)).toThrow();
    expect(existsSync(path.join(home, "state_5.sqlite"))).toBe(false);
  });

  test("rejects unavailable schema without modifying the database", () => {
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.close();
    expect(() => readCodexDescendantIds(home, "root", userAgent)).toThrow();
    const after = new DatabaseSync(path.join(home, "state_5.sqlite"), { readOnly: true });
    try {
      expect(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
        [],
      );
    } finally {
      after.close();
    }
  });
});
