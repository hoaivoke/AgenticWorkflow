import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { PM_WS_METHODS, PmError, PmRpcGroup, RpcScopeAuthorization } from "@t3tools/contracts";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { OrchestrationStudioService } from "../pipelines/OrchestrationStudioService.ts"; // pipelines:
import { PipelineService } from "../pipelines/PipelineService.ts"; // pipelines:
import { ThreadHarnessService } from "../pipelines/ThreadHarnessService.ts"; // pipelines:
import { SwarmService } from "../swarm/SwarmService.ts";

import { PmService } from "./PmService.ts";
import { PmT3Import } from "./t3/PmT3Import.ts";

// The middlewares the server group runs, so these handlers spread into its `.of`.
const PmServerRpcGroup =
  PmRpcGroup.middleware(RpcScopeAuthorization).middleware(RpcInstrumentation);

const ok = <E, R>(effect: Effect.Effect<unknown, E, R>) => Effect.as(effect, {});

const missing = new PmError({
  code: "unavailable",
  message: "This server runs without Project Managers.",
});

// Servers built without the PM layer (upstream's own tests) still answer, with a refusal.
const refuse = () => Effect.fail(missing);
const refuseStream = () => Stream.fail(missing);
const unavailableHandlers = PmServerRpcGroup.of({
  [PM_WS_METHODS.subscribe]: refuseStream,
  [PM_WS_METHODS.subscribeThread]: refuseStream,
  [PM_WS_METHODS.create]: refuse,
  [PM_WS_METHODS.setMission]: refuse,
  [PM_WS_METHODS.setInstructions]: refuse,
  [PM_WS_METHODS.remember]: refuse,
  [PM_WS_METHODS.forget]: refuse,
  [PM_WS_METHODS.editMemory]: refuse,
  [PM_WS_METHODS.askAnswer]: refuse,
  [PM_WS_METHODS.askSnooze]: refuse,
  [PM_WS_METHODS.askWake]: refuse,
  [PM_WS_METHODS.askDismiss]: refuse,
  [PM_WS_METHODS.askUndoDismiss]: refuse,
  [PM_WS_METHODS.pageGet]: refuse,
  [PM_WS_METHODS.pageAnswer]: refuse,
  [PM_WS_METHODS.pageMarkSeen]: refuse,
  [PM_WS_METHODS.pageOpen]: refuse,
  [PM_WS_METHODS.pageSnooze]: refuse,
  [PM_WS_METHODS.pageReopen]: refuse,
  [PM_WS_METHODS.itemArchive]: refuse,
  [PM_WS_METHODS.settingsGet]: refuse,
  [PM_WS_METHODS.settingsSet]: refuse,
  [PM_WS_METHODS.convert]: refuse,
  [PM_WS_METHODS.revert]: refuse,
  [PM_WS_METHODS.t3Status]: refuse,
  [PM_WS_METHODS.t3SetSync]: refuse,
  [PM_WS_METHODS.t3Import]: refuse,
  [PM_WS_METHODS.swarmGet]: () => Effect.succeed(null),
  [PM_WS_METHODS.swarmPost]: refuse,
  [PM_WS_METHODS.pipelinesGet]: refuse,
  [PM_WS_METHODS.roleSave]: refuse,
  [PM_WS_METHODS.roleDelete]: refuse,
  [PM_WS_METHODS.pipelineSave]: refuse,
  [PM_WS_METHODS.pipelineDelete]: refuse,
  [PM_WS_METHODS.threadHarnessGet]: refuse,
  [PM_WS_METHODS.threadHarnessSet]: refuse,
  [PM_WS_METHODS.pipelineRunsList]: refuse,
  [PM_WS_METHODS.pipelineRunStart]: refuse,
  [PM_WS_METHODS.pipelineStageDecide]: refuse,
  [PM_WS_METHODS.appVerifyRun]: refuse,
  [PM_WS_METHODS.evalRunsList]: refuse,
  [PM_WS_METHODS.evalRunStart]: refuse,
  [PM_WS_METHODS.evalRunVerify]: refuse,
  [PM_WS_METHODS.evalRunDelete]: refuse,
  [PM_WS_METHODS.learningsList]: refuse,
  [PM_WS_METHODS.learningPropose]: refuse,
  [PM_WS_METHODS.learningApply]: refuse,
  [PM_WS_METHODS.learningDismiss]: refuse,
});

/** Thin transport: each handler calls one PmService method. */
export const makePmRpcHandlers = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(PmService);
  if (Option.isNone(service)) return unavailableHandlers;
  const pm = service.value;
  const t3 = Option.getOrUndefined(yield* Effect.serviceOption(PmT3Import));
  const swarm = Option.getOrUndefined(yield* Effect.serviceOption(SwarmService));
  const pipelines = Option.getOrUndefined(yield* Effect.serviceOption(PipelineService)); // pipelines:
  const threadHarness = Option.getOrUndefined(yield* Effect.serviceOption(ThreadHarnessService)); // pipelines:
  const studio = Option.getOrUndefined(yield* Effect.serviceOption(OrchestrationStudioService)); // pipelines:
  const t3Call = <A>(run: (service: PmT3Import["Service"]) => Effect.Effect<A, PmError>) =>
    t3 === undefined ? Effect.fail(missing) : run(t3);
  const swarmCall = <A>(run: (service: SwarmService["Service"]) => Effect.Effect<A, PmError>) =>
    swarm === undefined ? Effect.fail(missing) : run(swarm);
  const pipelinesCall = <A>(
    run: (service: PipelineService["Service"]) => Effect.Effect<A, PmError>,
  ) => (pipelines === undefined ? Effect.fail(missing) : run(pipelines));
  const harnessCall = <A>(
    run: (service: ThreadHarnessService["Service"]) => Effect.Effect<A, PmError>,
  ) => (threadHarness === undefined ? Effect.fail(missing) : run(threadHarness));
  const studioCall = <A>(
    run: (service: OrchestrationStudioService["Service"]) => Effect.Effect<A, PmError>,
  ) => (studio === undefined ? Effect.fail(missing) : run(studio));
  return PmServerRpcGroup.of({
    [PM_WS_METHODS.subscribe]: ({ projectId }) => pm.subscribe(projectId),
    [PM_WS_METHODS.subscribeThread]: ({ pm: thread }) => pm.subscribeThread(thread),
    [PM_WS_METHODS.create]: ({ projectId, modelSelection }) =>
      pm.create({ projectId, modelSelection, createdBy: "user", creationSource: "web" }),
    [PM_WS_METHODS.setMission]: ({ pm: thread, mission }) =>
      ok(pm.setMission(thread, mission, "user")),
    [PM_WS_METHODS.setInstructions]: ({ pm: thread, instructions }) =>
      ok(pm.setInstructions(thread, instructions, "user")),
    [PM_WS_METHODS.remember]: ({ pm: thread, text }) =>
      Effect.map(pm.remember(thread, text, "user"), (number) => ({ number })),
    [PM_WS_METHODS.forget]: ({ pm: thread, number }) => ok(pm.forget(thread, number, "user")),
    [PM_WS_METHODS.editMemory]: ({ pm: thread, number, text }) =>
      ok(pm.editMemory(thread, number, text)),
    [PM_WS_METHODS.askAnswer]: ({ pm: thread, ask, answer }) =>
      ok(pm.answerAsk(thread, ask, answer)),
    [PM_WS_METHODS.askSnooze]: ({ pm: thread, ask, until }) => ok(pm.snoozeAsk(thread, ask, until)),
    [PM_WS_METHODS.askWake]: ({ pm: thread, ask }) => ok(pm.snoozeAsk(thread, ask, null)),
    [PM_WS_METHODS.askDismiss]: ({ pm: thread, ask }) => ok(pm.dismissAsk(thread, ask)),
    [PM_WS_METHODS.askUndoDismiss]: ({ pm: thread, ask }) => ok(pm.undoDismissAsk(thread, ask)),
    [PM_WS_METHODS.pageGet]: ({ pageId }) => pm.pageGet(pageId),
    [PM_WS_METHODS.pageAnswer]: ({ pageId, answers }) => ok(pm.pageAnswer(pageId, answers)),
    [PM_WS_METHODS.pageMarkSeen]: ({ pageId, reply }) => ok(pm.pageMarkSeen(pageId, reply)),
    [PM_WS_METHODS.pageOpen]: ({ pageId }) => ok(pm.pageOpen(pageId)),
    [PM_WS_METHODS.pageSnooze]: ({ pageId, until }) => ok(pm.pageSnooze(pageId, until)),
    [PM_WS_METHODS.pageReopen]: ({ pageId }) => ok(pm.pageReopen(pageId)),
    [PM_WS_METHODS.itemArchive]: ({ pm: thread, items, archived }) =>
      ok(pm.archiveItems(thread, items, archived)),
    [PM_WS_METHODS.settingsGet]: () => pm.getSettings,
    [PM_WS_METHODS.settingsSet]: (input) => pm.setSettings(input),
    [PM_WS_METHODS.convert]: ({ threadId }) => ok(pm.convert(threadId)),
    [PM_WS_METHODS.revert]: ({ pm: thread }) => ok(pm.revert(thread)),
    [PM_WS_METHODS.t3Status]: () => t3Call((service) => service.status),
    [PM_WS_METHODS.t3SetSync]: ({ enabled }) =>
      t3Call((service) => service.setSyncEnabled(enabled)),
    [PM_WS_METHODS.t3Import]: ({ mode }) => t3Call((service) => service.importThreads(mode)),
    [PM_WS_METHODS.swarmGet]: ({ threadId }) =>
      swarm === undefined ? Effect.succeed(null) : swarm.getBoardForThread(threadId),
    [PM_WS_METHODS.swarmPost]: ({ threadId, text, channel }) =>
      swarmCall((service) => service.postFromUser(threadId, text, channel)),
    [PM_WS_METHODS.pipelinesGet]: ({ projectId }) =>
      pipelinesCall((service) => service.snapshotFor(projectId)),
    [PM_WS_METHODS.roleSave]: ({ projectId, role, previousName }) =>
      pipelinesCall((service) => service.saveRole({ projectId, role, previousName })),
    [PM_WS_METHODS.roleDelete]: ({ projectId, name }) =>
      pipelinesCall((service) => service.deleteRole({ projectId, name })),
    [PM_WS_METHODS.pipelineSave]: ({ projectId, pipeline, previousName }) =>
      pipelinesCall((service) => service.savePipeline({ projectId, pipeline, previousName })),
    [PM_WS_METHODS.pipelineDelete]: ({ projectId, name }) =>
      pipelinesCall((service) => service.deletePipeline({ projectId, name })),
    [PM_WS_METHODS.threadHarnessGet]: ({ threadId }) =>
      harnessCall((service) => service.getState(threadId)),
    [PM_WS_METHODS.threadHarnessSet]: ({
      threadId,
      roleName,
      trackedSkills,
      trackedContextFiles,
    }) =>
      harnessCall((service) =>
        service.setHarness({ threadId, roleName, trackedSkills, trackedContextFiles }),
      ),
    [PM_WS_METHODS.pipelineRunsList]: ({ projectId }) =>
      studioCall((service) => service.listRuns(projectId)),
    [PM_WS_METHODS.pipelineRunStart]: ({ projectId, pipelineName, goal, budgetUsd }) =>
      studioCall((service) => service.startRun({ projectId, pipelineName, goal, budgetUsd })),
    [PM_WS_METHODS.pipelineStageDecide]: ({ runId, stageId, decision, note }) =>
      studioCall((service) => service.decideStage({ runId, stageId, decision, note })),
    [PM_WS_METHODS.appVerifyRun]: (input) => studioCall((service) => service.verifyApp(input)),
    [PM_WS_METHODS.evalRunsList]: ({ projectId }) =>
      studioCall((service) => service.listEvals(projectId)),
    [PM_WS_METHODS.evalRunStart]: (input) => studioCall((service) => service.startEval(input)),
    [PM_WS_METHODS.evalRunVerify]: ({ evalId }) =>
      studioCall((service) => service.verifyEval(evalId)),
    [PM_WS_METHODS.evalRunDelete]: ({ evalId }) =>
      ok(studioCall((service) => service.deleteEval(evalId))),
    [PM_WS_METHODS.learningsList]: ({ projectId }) =>
      studioCall((service) => service.listLearnings(projectId)),
    [PM_WS_METHODS.learningPropose]: (input) =>
      studioCall((service) => service.proposeLearning(input)),
    [PM_WS_METHODS.learningApply]: ({ learningId }) =>
      studioCall((service) => service.applyLearning(learningId)),
    [PM_WS_METHODS.learningDismiss]: ({ learningId }) =>
      studioCall((service) => service.dismissLearning(learningId)),
  });
});

/** The server's PmService, captured where the WebSocket route is built, for each connection. */
export const capturePmService = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(PmService);
  const t3 = yield* Effect.serviceOption(PmT3Import);
  const swarm = yield* Effect.serviceOption(SwarmService);
  const pipelines = yield* Effect.serviceOption(PipelineService); // pipelines:
  const threadHarness = yield* Effect.serviceOption(ThreadHarnessService); // pipelines:
  const studio = yield* Effect.serviceOption(OrchestrationStudioService); // pipelines:
  return Layer.mergeAll(
    Option.isNone(service) ? Layer.empty : Layer.succeed(PmService, service.value),
    Option.isNone(t3) ? Layer.empty : Layer.succeed(PmT3Import, t3.value),
    Option.isNone(swarm) ? Layer.empty : Layer.succeed(SwarmService, swarm.value),
    Option.isNone(pipelines) ? Layer.empty : Layer.succeed(PipelineService, pipelines.value),
    Option.isNone(threadHarness)
      ? Layer.empty
      : Layer.succeed(ThreadHarnessService, threadHarness.value),
    Option.isNone(studio) ? Layer.empty : Layer.succeed(OrchestrationStudioService, studio.value),
  );
});
