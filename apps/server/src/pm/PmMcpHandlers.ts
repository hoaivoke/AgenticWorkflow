import { OrchestratorMcpFailure, type PmError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PmRouting from "../pipelines/PmRouting.ts"; // pipelines:
import { PmToolkit } from "./PmMcpTools.ts";
import { PmRemote } from "./PmRemote.ts";
import { PmService } from "./PmService.ts";

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

/** Every `pm_*` tool acts for the calling thread, which must be a PM. */
// pipelines: generic in R so role routing can read its own services.
const asPm = Effect.fn("PmMcp.asPm")(function* <A, R = never>(
  run: (service: PmService["Service"], pm: string) => Effect.Effect<A, PmError, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
  const service = yield* PmService;
  return yield* run(service, caller.thread.threadId).pipe(Effect.mapError(toFailure));
});

/** As `asPm`, with the caller's scope for calls over the user's links (t3code-pm). */
const asPmRemote = Effect.fn("PmMcp.asPmRemote")(function* <A>(
  run: (
    remote: PmRemote["Service"],
    scope: McpInvocationContext.McpInvocationScope,
    pm: string,
  ) => Effect.Effect<A, PmError>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
  const remote = yield* PmRemote;
  return yield* run(remote, scope, caller.thread.threadId).pipe(Effect.mapError(toFailure));
});

export const layer = McpToolAccess.toLayer(PmToolkit, {
  pm_guide: McpToolAccess.reads(({ changes, pages }) =>
    asPm((service, pm) =>
      pages === true ? service.pageGuide(pm) : service.guide(pm, changes === true),
    ),
  ),
  pm_status: McpToolAccess.reads(() => asPm((service, pm) => service.status(pm))),
  pm_set_name: McpToolAccess.writesWithCapability(({ name }) =>
    asPm((service, pm) => service.setName(pm, name)),
  ),
  pm_set_mission: McpToolAccess.writesWithCapability(({ mission }) =>
    asPm((service, pm) => service.toolResult(pm, () => service.setMission(pm, mission, "pm"))),
  ),
  pm_set_instructions: McpToolAccess.writesWithCapability(({ instructions }) =>
    asPm((service, pm) =>
      service.toolResult(pm, () => service.setInstructions(pm, instructions, "pm")),
    ),
  ),
  pm_remember: McpToolAccess.writesWithCapability(({ text: note }) =>
    asPm((service, pm) =>
      service.toolResult(pm, () =>
        service
          .remember(pm, note, "pm")
          .pipe(Effect.map((number) => `Saved as memory note ${number}.`)),
      ),
    ),
  ),
  pm_forget: McpToolAccess.writesWithCapability(({ number }) =>
    asPm((service, pm) => service.toolResult(pm, () => service.forget(pm, number, "pm"))),
  ),
  pm_playbook_override: McpToolAccess.writesWithCapability((input) =>
    asPm((service, pm) => service.playbookOverride(pm, input)),
  ),
  pm_computers: McpToolAccess.reads(() =>
    asPmRemote((remote, scope, pm) => remote.computers(scope, pm)),
  ),
  pm_worker_start: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      asPmRemote((remote, scope, pm) =>
        Effect.gen(function* () {
          // pipelines: a role picks the model and adds its instructions to the brief.
          const routed =
            input.role === undefined
              ? undefined
              : yield* PmRouting.routeWorker({
                  pm,
                  role: input.role,
                  escalate: input.escalate,
                  avoidProviderOf: input.avoid_provider_of,
                  modelSelection: input.modelSelection,
                });
          const result = yield* remote.startWorker(scope, pm, {
            computerName: input.computer,
            cloneTo: input.clone_to,
            title: input.title,
            brief:
              routed === undefined
                ? input.brief
                : `${routed.preamble}\n\n## Your task\n${input.brief}`,
            item: input.item,
            modelSelection: routed?.modelSelection ?? input.modelSelection,
            workspaceStrategy: input.workspaceStrategy,
            runtimeMode,
            interactionMode,
            linkOrigin,
          });
          return routed === undefined
            ? result
            : { ...result, result: `${result.result} ${routed.summary}` };
        }),
      ),
    "stamped",
  ),
  pm_worker_link: McpToolAccess.writesWithCapability(({ thread, item, computer }) =>
    asPmRemote((remote, scope, pm) =>
      remote.linkWorker(scope, pm, { thread, item, computerName: computer }),
    ),
  ),
  pm_worker_unlink: McpToolAccess.writesWithCapability(({ thread }) =>
    asPm((service, pm) => service.unlinkWorker(pm, thread)),
  ),
  pm_worker_resolve: McpToolAccess.writesWithCapability(({ thread }) =>
    asPm((service, pm) => service.resolveWorker(pm, thread)),
  ),
  pm_item_add: McpToolAccess.writesWithCapability(({ title, thread }) =>
    asPm((service, pm) => service.itemAdd(pm, { title, thread })),
  ),
  pm_item_update: McpToolAccess.writesWithCapability(({ step_done, ...input }) =>
    asPm((service, pm) => service.itemUpdate(pm, { ...input, stepDone: step_done })),
  ),
  pm_item_list: McpToolAccess.reads((input) =>
    asPm((service, pm) => service.itemList(pm, input.check === true)),
  ),
  pm_ask: McpToolAccess.writesWithCapability((input) =>
    asPm((service, pm) => service.ask(pm, input)),
  ),
  pm_ask_done: McpToolAccess.writesWithCapability(({ tag }) =>
    asPm((service, pm) => service.askDone(pm, tag)),
  ),
  pm_ask_withdraw: McpToolAccess.writesWithCapability(({ tag }) =>
    asPm((service, pm) => service.askWithdraw(pm, tag)),
  ),
  pm_next_tag: McpToolAccess.reads(() => asPm((service, pm) => service.nextTag(pm))),
  pm_worker_note: McpToolAccess.writesWithCapability(({ note }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
      const service = yield* PmService;
      return yield* service
        .workerNote(caller.thread.threadId, note)
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  pm_link_add: McpToolAccess.writesWithCapability((input) =>
    asPm((service, pm) => service.linkAdd(pm, input)),
  ),
  pm_page_show: McpToolAccess.writesWithCapability(({ source_name, question_tags, ...input }) =>
    asPm((service, pm) =>
      service.pageShow(pm, { ...input, sourceName: source_name, questionTags: question_tags }),
    ),
  ),
  pm_page_retire: McpToolAccess.writesWithCapability(({ page }) =>
    asPm((service, pm) => service.pageRetire(pm, page)),
  ),
  // Numbers and agent names only, and only to a linked computer (the tool is hidden from threads).
  pm_host_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const remote = yield* PmRemote;
      return yield* remote.hostStatus;
    }),
  ),
  pm_worker_schedule: McpToolAccess.startsThreads(
    // pipelines:
    () => ({}),
    ({ schedule, enabled, ...startArguments }) =>
      asPm((service, pm) =>
        PmRouting.scheduleWorker({
          pm,
          title: startArguments.title,
          startArguments,
          schedule,
          enabled,
        }).pipe(Effect.flatMap((text) => service.toolResult(pm, () => Effect.succeed(text)))),
      ),
    // A scheduled run starts long after its caller, with nothing to carry the link.
    { refused: "schedule workers in this environment" },
  ),
  pm_pipelines: McpToolAccess.reads(({ name }) =>
    // pipelines:
    asPm((service, pm) =>
      PmRouting.pipelinesText(pm, name).pipe(
        Effect.flatMap((text) => service.toolResult(pm, () => Effect.succeed(text))),
      ),
    ),
  ),
  pm_roles: McpToolAccess.reads(() =>
    // pipelines:
    asPm((service, pm) =>
      PmRouting.rolesText(pm).pipe(
        Effect.flatMap((text) => service.toolResult(pm, () => Effect.succeed(text))),
      ),
    ),
  ),
});
