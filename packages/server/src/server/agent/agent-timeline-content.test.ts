import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

function contentItems(text: string): AgentTimelineItem[] {
  const base = { type: "tool_call" as const, callId: "content", name: "tool" };
  return [
    { ...base, status: "completed", error: null, detail: { type: "plain_text", text } },
    {
      ...base,
      status: "completed",
      error: null,
      detail: { type: "shell", command: "example", output: text },
    },
    {
      ...base,
      status: "failed",
      error: { content: text, code: "failed" },
      detail: { type: "shell", command: "example" },
    },
  ];
}

describe("agent timeline content", () => {
  test.each(["text", "structured"])(
    "bounds unknown %s results without retaining the native payload",
    (kind) => {
      const text = "界".repeat(100_000);
      const output =
        kind === "text" ? text : { content: [{ type: "text", text }], structuredContent: { text } };
      const item: AgentTimelineItem = {
        type: "tool_call",
        callId: "mcp",
        name: "mcp__custom__fetch",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { query: "keep" }, output },
      };
      const limited = limitAgentTimelineItemContent(item);
      const visible = typeof output === "string" ? output : JSON.stringify(output, null, 2);
      expect(limited).toEqual({
        ...item,
        detail: { ...item.detail, output: visible.slice(0, 64 * 1024) },
      });
    },
  );
  test("preserves a small structured result and its identity", () => {
    const item: AgentTimelineItem = {
      type: "tool_call",
      callId: "mcp",
      name: "mcp__custom__fetch",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: {},
        output: { content: [{ type: "text", text: "small" }] },
      },
    };
    expect(limitAgentTimelineItemContent(item)).toBe(item);
  });
  test("preserves UTF-16 content when the limit splits a surrogate pair", () => {
    const prefix = "界".repeat(64 * 1024 - 1) + "\ud83d";
    expect(contentItems(prefix + "\ude00tail").map(limitAgentTimelineItemContent)).toEqual(
      contentItems(prefix),
    );
  });

  test("keeps content at and below the limit unchanged", () => {
    for (const item of [
      ...contentItems("short\u0000\ud800"),
      ...contentItems("x".repeat(64 * 1024)),
    ]) {
      expect(limitAgentTimelineItemContent(item)).toBe(item);
    }
  });

  test.each(["plain_text", "shell", "error"])(
    "%s truncation releases the oversized backing string",
    (kind) => {
      const fixture = fileURLToPath(
        new URL("./test-utils/timeline-content-memory-repro.ts", import.meta.url),
      );
      const output = execFileSync(
        process.execPath,
        ["--expose-gc", "--import", "tsx", fixture, kind],
        {
          encoding: "utf8",
        },
      );
      // A retained 16 MiB source must not survive behind a visible 64 KiB prefix.
      expect(Number(output)).toBeLessThan(2 * 1024 * 1024);
    },
    30_000,
  );

  test("limits terminal input to the tool-call content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024),
        icon: "square_terminal",
      },
    });
  });
});
