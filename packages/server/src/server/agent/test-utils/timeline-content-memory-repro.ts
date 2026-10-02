import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";

function retainedItem(kind: string) {
  const source = "x".repeat(16 * 1024 * 1024);
  source.charCodeAt(source.length - 1);
  const base = { type: "tool_call" as const, callId: "memory", name: "tool" };
  switch (kind) {
    case "plain_text":
      return limitAgentTimelineItemContent({
        ...base,
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: source },
      });
    case "shell":
      return limitAgentTimelineItemContent({
        ...base,
        status: "completed",
        error: null,
        detail: { type: "shell", command: "example", output: source },
      });
    case "error":
      return limitAgentTimelineItemContent({
        ...base,
        status: "failed",
        error: { content: source },
        detail: { type: "shell", command: "example" },
      });
    default:
      throw new Error("Expected plain_text, shell or error");
  }
}

if (!global.gc) throw new Error("Run with --expose-gc");
global.gc();
const before = process.memoryUsage().heapUsed;
const held = retainedItem(process.argv[2]);
global.gc();
global.gc();
process.stdout.write(String(process.memoryUsage().heapUsed - before));
if (held.type !== "tool_call") throw new Error("Missing retained tool call");
