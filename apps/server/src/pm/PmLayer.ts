import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as OrchestrationStudioService from "../pipelines/OrchestrationStudioService.ts"; // pipelines:
import * as ThreadHarnessService from "../pipelines/ThreadHarnessService.ts"; // pipelines:
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

// pipelines: shared memoized instances from runtimeLayer so ProviderTurnStartService, RPC and MCP agree.
const layerPipelines = RuntimeLayer.layerPipelines.pipe(
  Layer.provide(RuntimeLayer.layerProjectService),
);
const layerThreadHarness = RuntimeLayer.layerThreadHarness.pipe(
  Layer.provide(RuntimeLayer.layerProjectService),
);

const layerSwarm = SwarmService.layer.pipe(
  Layer.provideMerge(SwarmStore.layer),
  Layer.provideMerge(layerPipelines),
);

const layerStudio = OrchestrationStudioService.layer.pipe(
  Layer.provideMerge(
    PmT3Import.layer.pipe(
      Layer.provideMerge(layerCore),
      Layer.provideMerge(layerPipelines),
      Layer.provideMerge(layerThreadHarness),
      Layer.provide(Layer.merge(RuntimeLayer.layerEventSink, ProjectionStore.layer)),
    ),
  ),
  Layer.provide(RuntimeLayer.layerProjectService),
);

/** With the T3 Code import. One value, so every use memoizes to one instance. */
export const layer = Layer.mergeAll(layerStudio, layerSwarm);

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
  SwarmService.layerWatcher.pipe(Layer.provide(layer), Layer.provide(Scheduler.layer)),
  ThreadHarnessService.layerWatcher.pipe(
    Layer.provide(layer),
    Layer.provide(RuntimeLayer.layerProjectService),
  ),
);

/** Workers on the user's linked computers. One value: /mcp and the followers share one instance. */
export const layerRemote = PmRemote.layer.pipe(Layer.provide(layer));

/** Follows workers on other computers, including after a restart. Needs the peer links. */
export const layerRemoteFollowers = Layer.effectDiscard(
  PmRemote.PmRemote.pipe(Effect.flatMap((remote) => remote.start())),
);
