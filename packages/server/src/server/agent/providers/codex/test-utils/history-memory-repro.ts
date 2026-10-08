import pino from "pino";
import { asInternals } from "../../../../test-utils/class-mocks.js";

const moduleUrl =
  process.argv[2] || new URL("../../codex-app-server-agent.js", import.meta.url).href;
const { CodexAppServerAgentSession } = await import(moduleUrl);
const session = new CodexAppServerAgentSession(
  { provider: "codex", cwd: process.cwd() },
  { sessionId: "root" },
  pino({ level: "silent" }),
  async () => {
    throw new Error("History fixture must not spawn a provider");
  },
);
const count = 400;
const size = 512 * 1024;
const item = (index: number) =>
  process.argv[3] === "mcp"
    ? {
        type: "mcpToolCall",
        id: `mcp-${index}`,
        server: "custom",
        tool: "fetch",
        status: "completed",
        arguments: {},
        result: {
          content: [{ type: "text", text: Buffer.alloc(size, 65 + (index % 26)).toString("utf8") }],
          structuredContent: { value: Buffer.alloc(size, 65 + (index % 26)).toString("utf8") },
        },
      }
    : {
        type: "commandExecution",
        id: `command-${index}`,
        command: "example",
        cwd: process.cwd(),
        status: "completed",
        exitCode: 0,
        aggregatedOutput: Buffer.alloc(size, 65 + (index % 26)).toString("utf8"),
      };
const client = {
  async request(method: string, params: Record<string, unknown>) {
    if (method === "thread/read")
      return {
        thread: {
          turns: params.includeTurns
            ? [{ id: "turn", items: Array.from({ length: count }, (_, index) => item(index)) }]
            : [],
        },
      };
    if (method === "thread/turns/list")
      return { data: [{ id: "turn", status: "completed" }], nextCursor: null };
    if (method !== "thread/items/list") throw new Error(`Unexpected method ${method}`);
    const start = Number(params.cursor ?? 0);
    const limit = Number(params.limit);
    const end = Math.min(start + limit, count);
    return {
      data: Array.from({ length: end - start }, (_, offset) => ({
        turnId: "turn",
        item: item(params.sortDirection === "desc" ? count - start - offset - 1 : start + offset),
        startedAtMs: null,
        completedAtMs: null,
      })),
      nextCursor: end === count ? null : String(end),
    };
  },
};
global.gc?.();
const baseline = process.memoryUsage().heapUsed;
await asInternals<{ loadPersistedHistory(client: typeof client): Promise<void> }>(
  session,
).loadPersistedHistory(client);
global.gc?.();
const retained = process.memoryUsage().heapUsed - baseline;
let rows = 0;
let maxOutput = 0;
const callIds: string[] = [];
for await (const event of session.streamHistory()) {
  if (event.type !== "timeline") continue;
  rows++;
  if (event.item.type === "tool_call") callIds.push(event.item.callId);
  maxOutput = Math.max(maxOutput, event.item.detail?.output?.length ?? 0);
}
process.stdout.write(
  JSON.stringify({
    retained,
    rows,
    maxOutput,
    firstCallId: callIds[0],
    lastCallId: callIds.at(-1),
  }),
);
