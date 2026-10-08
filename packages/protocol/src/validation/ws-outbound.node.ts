import { WSOutboundMessageSchema } from "../messages.js";
import type { WSOutboundValidationResult } from "./ws-outbound.js";

// The monolithic generated validator exceeds 1 GiB during V8 compilation.
// Hermes keeps its AOT path; Node validates the same wire schema directly.
export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  return WSOutboundMessageSchema.safeParse(input);
}
