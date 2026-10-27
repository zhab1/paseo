import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;
// Initial native history page and child preview size; older history remains pageable.
export const AGENT_TIMELINE_ITEM_LIMIT = 200;
export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (serializedBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

/** A sliced string can keep the entire provider output alive. Copy only the retained UTF-16
 * units, including an unmatched surrogate at the existing character limit. */
function retainTextPrefix(text: string, length: number): string {
  return Buffer.from(text.slice(0, length), "utf16le").toString("utf16le");
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
      content: retainTextPrefix(item.error.content, TOOL_CALL_CONTENT_MAX_LENGTH),
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
  const notice = "\n\n[Content truncated]";
  return {
    ...item,
    detail: {
      ...item.detail,
      text:
        retainTextPrefix(item.detail.text, TOOL_CALL_CONTENT_MAX_LENGTH - notice.length) + notice,
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
  return {
    ...item,
    detail: { ...item.detail, output: retainTextPrefix(text, TOOL_CALL_CONTENT_MAX_LENGTH) },
  };
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
      output: retainTextPrefix(item.detail.output, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}
