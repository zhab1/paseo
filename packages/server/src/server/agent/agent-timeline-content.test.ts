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
