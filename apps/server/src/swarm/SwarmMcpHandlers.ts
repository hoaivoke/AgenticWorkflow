import { OrchestratorMcpFailure, type PmError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { SwarmToolkit } from "./SwarmMcpTools.ts";
import { SwarmService } from "./SwarmService.ts";

const toFailure = (error: PmError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "disabled"
        ? "capability_denied"
        : error.code === "unavailable"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

const asCaller = Effect.fn("SwarmMcp.asCaller")(function* <A, R = never>(
  run: (service: SwarmService["Service"], threadId: string) => Effect.Effect<A, PmError, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Swarm tools");
  const service = yield* SwarmService;
  return yield* run(service, caller.thread.threadId).pipe(Effect.mapError(toFailure));
});

export const layer = McpToolAccess.toLayer(SwarmToolkit, {
  swarm: McpToolAccess.startsThreads(
    () => ({}),
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      asCaller((service, threadId) =>
        service.swarmAction(threadId, { runtimeMode, interactionMode, linkOrigin }, input),
      ),
    "stamped",
  ),
  post_message: McpToolAccess.actsAsCaller((input) =>
    asCaller((service, threadId) => service.postMessage(threadId, input)),
  ),
  read_board: McpToolAccess.reads((input) =>
    asCaller((service, threadId) => service.readBoard(threadId, input)),
  ),
  swarm_wait: McpToolAccess.actsAsCaller(({ mentions_only, ...input }) =>
    asCaller((service, threadId) =>
      service.swarmWait(threadId, { ...input, mentionsOnly: mentions_only }),
    ),
  ),
});
