import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as PmReportWatcher from "./PmReportWatcher.ts";
import * as PmService from "./PmService.ts";
import * as PmStore from "./PmStore.ts";
import * as PmT3Import from "./t3/PmT3Import.ts";

/** PmService over its store. */
export const layerCore = PmService.layer.pipe(Layer.provideMerge(PmStore.layer));

/** With the T3 Code import. One value, so every use memoizes to one instance. */
export const layer = PmT3Import.layer.pipe(
  Layer.provideMerge(layerCore),
  // The runtime's own instances (layers memoize by reference), so imports publish to live clients.
  Layer.provide(Layer.merge(RuntimeLayer.layerEventSink, ProjectionStore.layer)),
);

/** Starts the worker report watcher once the server is active. */
export const layerWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const watcher = yield* PmReportWatcher.PmReportWatcher;
    yield* watcher.start();
    // New T3 Code projects, once the server can create them. Settings ran before startup.
    const t3 = yield* PmT3Import.PmT3Import;
    yield* ServerActivation.forkParkedFiber(t3.syncProjectsAtLaunch);
  }),
).pipe(Layer.provide(PmReportWatcher.layer), Layer.provide(layer), Layer.provide(Scheduler.layer));
