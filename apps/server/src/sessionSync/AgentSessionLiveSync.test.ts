// pipelines: live sync over a real Claude Code transcript file, a real event sink and projections.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionLiveSync from "./AgentSessionLiveSync.ts";

const projectId = ProjectId.make("live-sync-project");
const sessionId = "0f6c1d2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5";
const threadId = ThreadId.make(`import:claudeAgent:${sessionId}`);
const createdAt = "2026-11-25T07:00:00.000Z";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
);

const claudeLine = (role: "user" | "assistant", text: string) =>
  `${JSON.stringify(
    role === "user"
      ? { type: "user", sessionId, timestamp: createdAt, message: { role, content: text } }
      : {
          type: "assistant",
          sessionId,
          timestamp: createdAt,
          message: { role, content: [{ type: "text", text }] },
        },
  )}\n`;

/** Imports one Claude Code conversation from `filePath`, then returns the live sync service. */
const setup = Effect.fn(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const stats = yield* fs.stat(filePath);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerInstanceId = ProviderInstanceId.make("claudeAgent");
  const candidate: AgentSessionScanner.AgentSessionRecentThread = {
    _tag: "Importable",
    source: {
      provider: "claudeAgent",
      providerInstanceId,
      providerSessionId: sessionId,
      filePath,
      size: Number(stats.size),
      mtimeMs: Option.getOrThrow(stats.mtime).getTime(),
      device: Number(stats.dev),
      inode: Option.match(stats.ino, { onNone: () => null, onSome: String }),
      birthtimeMs: null,
    },
    thread: {
      source: "claudeAgent",
      providerInstanceId,
      providerSessionId: sessionId,
      title: "Fix it",
      model: null,
      createdAt,
      updatedAt: createdAt,
      omittedMessageCount: 0,
      messages: [
        { role: "user", text: "Fix it", createdAt },
        { role: "assistant", text: "Fixed", createdAt },
      ],
    },
    worktree: null,
  };
  const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadRecords: (id, fields) =>
      projections
        .getThreadRecords(id, fields)
        .pipe(
          Effect.mapError(
            (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
          ),
        ),
  });
  const shared = Layer.mergeAll(
    Layer.succeed(EventSink.EventSinkV2, yield* EventSink.EventSinkV2),
    Layer.succeed(
      ProviderSessionRuntime.ProviderSessionRuntimeRepository,
      yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    ),
    Layer.succeed(
      ThreadCommandExecutor.ThreadCommandExecutor,
      yield* ThreadCommandExecutor.ThreadCommandExecutor,
    ),
    orchestrator,
  );
  const importer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        shared,
        ServerSettings.layerTest(),
        Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
        Layer.mock(AgentSessionScanner.AgentSessionScanner)({
          recentThreads: () => Stream.make(candidate),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Project",
              workspaceRoot: "/workspace/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
              deletedAt: null,
            }),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      ),
    ),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(importer, AgentSessionLiveSync.layerService.pipe(Layer.provide(importer))).pipe(
      Layer.provide(shared),
    ),
  );
  const imported = yield* Context.get(
    context,
    AgentSessionImporter.AgentSessionImporter,
  ).importRecentAgentThreads({ projectId });
  expect(imported.importedCount).toBe(1);
  return Context.get(context, AgentSessionLiveSync.AgentSessionLiveSync);
});

const threadTexts = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const records = yield* projections.getThreadRecords(threadId, ["messages"]);
  return {
    texts: records.messages
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((message) => `${message.role}: ${message.text}`),
    updatedAt: DateTime.formatIso(records.thread.updatedAt),
  };
});

it.effect("follows a Claude Code conversation that continues outside the app", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-live-sync-" });
    const file = path.join(dir, `${sessionId}.jsonl`);
    yield* fs.writeFileString(
      file,
      claudeLine("user", "Fix it") + claudeLine("assistant", "Fixed"),
    );
    const sync = yield* setup(file);

    // Unchanged since the import: one stat, nothing added.
    expect(yield* sync.sweep()).toEqual({ appended: 0, discoveredProjects: 1 });

    const later = "2026-11-25T08:30:00.000Z";
    const more = [
      {
        type: "user",
        sessionId,
        timestamp: later,
        message: { role: "user", content: "Now add a test" },
      },
      {
        type: "assistant",
        sessionId,
        timestamp: later,
        message: { role: "assistant", content: [{ type: "text", text: "Added one." }] },
      },
    ];
    // A half-written final line is skipped until Claude Code finishes it.
    yield* fs.writeFileString(
      file,
      `${more.map((record) => JSON.stringify(record)).join("\n")}\n{"type":"assist`,
      { flag: "a" },
    );
    expect((yield* sync.sweep()).appended).toBe(2);
    const after = yield* threadTexts;
    expect(after.texts).toEqual([
      "user: Fix it",
      "assistant: Fixed",
      "user: Now add a test",
      "assistant: Added one.",
    ]);
    expect(after.updatedAt).toBe(later);

    // The same transcript again adds nothing.
    yield* fs.writeFileString(file, "\n", { flag: "a" });
    expect((yield* sync.sweep()).appended).toBe(0);
    expect((yield* threadTexts).texts).toHaveLength(4);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("adds nothing when the transcript no longer holds the thread's history", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-live-sync-" });
    const file = path.join(dir, `${sessionId}.jsonl`);
    yield* fs.writeFileString(
      file,
      claudeLine("user", "Fix it") + claudeLine("assistant", "Fixed"),
    );
    const sync = yield* setup(file);

    yield* fs.writeFileString(
      file,
      claudeLine("user", "Something else") + claudeLine("assistant", "Sure"),
    );
    expect((yield* sync.sweep()).appended).toBe(0);
    expect((yield* threadTexts).texts).toEqual(["user: Fix it", "assistant: Fixed"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
