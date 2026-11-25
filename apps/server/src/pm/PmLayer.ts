import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PipelineService from "../pipelines/PipelineService.ts"; // pipelines:
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as PmRemote from "./PmRemote.ts";
import * as SwarmService from "../swarm/SwarmService.ts";
import * as SwarmStore from "../swarm/SwarmStore.ts";
import * as PmReportWatcher from "./PmReportWatcher.ts";
import * as PmService from "./PmService.ts";
import * as PmStore from "./PmStore.ts";
import * as PmT3Import from "./t3/PmT3Import.ts";

/** PmService over its store. */
export const layerCore = PmService.layer.pipe(Layer.provideMerge(PmStore.layer));

// pipelines: role routing for pm_worker_start, beside the PM services in the server's layer.
const layerPipelines = PipelineService.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService));

const layerSwarm = SwarmService.layer.pipe(
  Layer.provideMerge(SwarmStore.layer),
  Layer.provideMerge(layerPipelines),
);

/** With the T3 Code import. One value, so every use memoizes to one instance. */
export const layer = Layer.mergeAll(
  PmT3Import.layer.pipe(
    Layer.provideMerge(layerCore),
    Layer.provideMerge(layerPipelines), // pipelines:
    // The runtime's own instances (layers memoize by reference), so imports publish to live clients.
    Layer.provide(Layer.merge(RuntimeLayer.layerEventSink, ProjectionStore.layer)),
  ),
  layerSwarm,
);

/** Starts the worker report watcher once the server is active. */
export const layerWatcher = Layer.mergeAll(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const watcher = yield* PmReportWatcher.PmReportWatcher;
      yield* watcher.start();
      // New T3 Code projects, once the server can create them. Settings ran before startup.
      const t3 = yield* PmT3Import.PmT3Import;
      yield* ServerActivation.forkParkedFiber(t3.syncProjectsAtLaunch);
    }),
  ).pipe(
    Layer.provide(PmReportWatcher.layer),
    Layer.provide(layer),
    Layer.provide(Scheduler.layer),
  ),
  SwarmService.layerWatcher.pipe(Layer.provide(layer)),
);

/** Workers on the user's linked computers. One value: /mcp and the followers share one instance. */
export const layerRemote = PmRemote.layer.pipe(Layer.provide(layer));

/** Follows workers on other computers, including after a restart. Needs the peer links. */
export const layerRemoteFollowers = Layer.effectDiscard(
  PmRemote.PmRemote.pipe(Effect.flatMap((remote) => remote.start())),
);
