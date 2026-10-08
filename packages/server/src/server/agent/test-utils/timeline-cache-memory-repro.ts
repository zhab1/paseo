import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import { ProviderSubagentStore } from "../provider-subagents/store.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineFetchOptions } from "../agent-timeline-store-types.js";
import { TimelineCache } from "../timeline-cache.js";

const directory = path.join(process.cwd(), ".dev", "timeline-cache-tests", randomUUID());
const cache = new TimelineCache(path.join(directory, "timeline.sqlite"));
const assistantFragments = process.argv[2] === "assistant";
try {
  const store = new InMemoryAgentTimelineStore(cache);
  store.initialize("large");
  const child = process.argv[2] === "child" ? new ProviderSubagentStore(cache) : null;
  child?.apply("parent", "codex", { type: "upsert", id: "child" });
  const append = (item: AgentTimelineItem) =>
    child
      ? child.apply("parent", "codex", { type: "timeline", id: "child", item })
      : store.append("large", item);
  const fetch = (options: AgentTimelineFetchOptions) =>
    child ? child.fetchTimeline("parent", "child", options) : store.fetch("large", options);
  global.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) {
    const buffer = Buffer.alloc(64 * 1024, 65 + (i % 26));
    buffer.write(String(i));
    if (assistantFragments) {
      append({
        type: "assistant_message",
        messageId: "long-turn",
        text: buffer.toString(),
      });
      append({ type: "reasoning", text: "interleaved" });
      continue;
    }
    append({
      type: "tool_call",
      callId: `call-${i}`,
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "plain_text", label: "Output", text: buffer.toString() },
    });
  }
  global.gc?.();
  await child?.hydrateTimeline("parent", "child", async () => [
    {
      item: { type: "assistant_message", messageId: "saved", text: "older native page" },
    },
  ]);
  global.gc?.();
  const retained = process.memoryUsage().heapUsed - baseline;
  let page = fetch({ limit: 40 });
  let rows = page.rows.length;
  const ids = new Set(page.rows.map((row) => row.seqStart));
  while (page.hasOlder) {
    page = fetch({
      direction: "before",
      limit: 40,
      cursor: { epoch: page.epoch, seq: page.startSeq! },
    });
    rows += page.rows.length;
    for (const row of page.rows) ids.add(row.seqStart);
  }
  process.stdout.write(JSON.stringify({ retained, rows, unique: ids.size }));
} finally {
  cache.close();
  rmSync(directory, { recursive: true, force: true });
}
