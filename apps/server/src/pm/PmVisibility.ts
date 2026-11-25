import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

// `McpSchema.EnabledWhen` is synchronous, so tool discovery reads this mirror of `pm_threads` and
// the switch. PmService keeps it current; handlers still check the database on every call.
const state = { enabled: true, pms: new Set<string>(), workers: new Set<string>() };

export const pmVisibility = {
  reset: (enabled: boolean, pms: Iterable<string>) => {
    state.enabled = enabled;
    state.pms = new Set(pms);
  },
  setEnabled: (enabled: boolean) => {
    state.enabled = enabled;
  },
  add: (threadId: string) => void state.pms.add(threadId),
  remove: (threadId: string) => void state.pms.delete(threadId),
  setWorkers: (workers: Iterable<string>) => {
    state.workers = new Set(workers);
  },
};

const callerThreadId = () => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.thread?.threadId;
};

/** `McpSchema.EnabledWhen` for `pm_*` tools: only PM threads see them, and only while on. */
export const hiddenUnlessPm = (): boolean => {
  const threadId = callerThreadId();
  return threadId !== undefined && state.enabled && state.pms.has(threadId);
};

/** The same for the tools a PM's workers call: only threads linked to a PM see them. */
export const hiddenUnlessPmWorker = (): boolean => {
  const threadId = callerThreadId();
  return threadId !== undefined && state.enabled && state.workers.has(threadId);
};
