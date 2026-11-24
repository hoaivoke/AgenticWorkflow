import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { PM_WS_METHODS, PmError, PmRpcGroup, RpcScopeAuthorization } from "@t3tools/contracts";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";

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
});

/** Thin transport: each handler calls one PmService method. */
export const makePmRpcHandlers = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(PmService);
  if (Option.isNone(service)) return unavailableHandlers;
  const pm = service.value;
  const t3 = Option.getOrUndefined(yield* Effect.serviceOption(PmT3Import));
  const t3Call = <A>(run: (service: PmT3Import["Service"]) => Effect.Effect<A, PmError>) =>
    t3 === undefined ? Effect.fail(missing) : run(t3);
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
  });
});

/** The server's PmService, captured where the WebSocket route is built, for each connection. */
export const capturePmService = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(PmService);
  const t3 = yield* Effect.serviceOption(PmT3Import);
  return Layer.mergeAll(
    Option.isNone(service) ? Layer.empty : Layer.succeed(PmService, service.value),
    Option.isNone(t3) ? Layer.empty : Layer.succeed(PmT3Import, t3.value),
  );
});
