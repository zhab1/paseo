import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;
export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

function copyContentPrefix(content: string): string {
  // V8 slices can retain the entire oversized source. Copy the UTF-16 code units,
  // including a surrogate split at the existing character limit, into bounded storage.
  return Buffer.from(content.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH), "utf16le").toString("utf16le");
}

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (serializedBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null ||
    !("content" in item.error) ||
    typeof item.error.content !== "string" ||
    item.error.content.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    error: {
      ...item.error,
      content: copyContentPrefix(item.error.content),
    },
  };
}

function limitPlainText(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "plain_text" ||
    typeof item.detail.text !== "string" ||
    item.detail.text.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      text: copyContentPrefix(item.detail.text),
    },
  };
}

function limitUnknownOutput(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "tool_call" || item.detail.type !== "unknown") return item;
  // Unknown results render as text/JSON. Preserve small structured values, but do
  // not retain oversized native result objects behind a bounded history page.
  const output = item.detail.output;
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  if (text === undefined || text.length <= TOOL_CALL_CONTENT_MAX_LENGTH) return item;
  return { ...item, detail: { ...item.detail, output: copyContentPrefix(text) } };
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  item = limitPlainText(item);
  item = limitUnknownOutput(item);
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    typeof item.detail.output !== "string"
  ) {
    return item;
  }
  if (item.detail.output.length <= TOOL_CALL_CONTENT_MAX_LENGTH) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      output: copyContentPrefix(item.detail.output),
    },
  };
}
