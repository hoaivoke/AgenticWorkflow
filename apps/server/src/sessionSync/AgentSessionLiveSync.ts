// pipelines: keeps imported Claude Code conversations current while they continue outside the app.
import {
  EventId,
  type AgentSessionImportSource,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import {
  decodeImportedTranscriptPayload,
  parseAgentSessionTranscript,
} from "../project/AgentSessionScanner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { messagesToAppend, nextImportedMessageIndex } from "./liveSync.logic.ts";

/**
 * Codex's parser drops a turn's response-copied user messages once the turn ends, so a
 * mid-turn read can disagree with a later one; only append-only transcripts are followed.
 */
const FOLLOWED_SOURCES: ReadonlySet<string> = new Set(["claudeAgent"]);
const MAX_FOLLOWED_BYTES = 256 * 1024 * 1024;
/** New conversations are looked for every this many scheduler ticks (5 s each). */
const DISCOVERY_EVERY_SWEEPS = 12;
const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export interface SyncResult {
  readonly appended: number;
  readonly discoveredProjects: number;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;

  /** Last transcript size and mtime handled per thread; unchanged files cost one stat. */
  const handled = new Map<ThreadId, string>();
  /** Threads deleted, no longer imported, or with transcripts gone or too large to follow. */
  const stopped = new Set<ThreadId>();
  let sweeps = 0;

  const append = Effect.fn("AgentSessionLiveSync.append")(function* (
    threadId: ThreadId,
    transcript: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly createdAt: string;
    }>,
  ) {
    const records = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
    if (records.thread.historyOrigin !== "v1_import" || records.thread.deletedAt !== null) {
      stopped.add(threadId);
      return null;
    }
    // A turn the app is running may be writing this same transcript; read it once it settles.
    if (records.runs.some((run) => !SETTLED_RUN_STATUSES.has(run.status))) return null;
    const transcriptIdPrefix = `${threadId}:`;
    const stored = records.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map((message) => ({
        role: message.role as "user" | "assistant",
        text: message.text,
        fromTranscript:
          message.id.startsWith(transcriptIdPrefix) &&
          /^\d{6,}$/.test(message.id.slice(transcriptIdPrefix.length)),
      }));
    const fresh = messagesToAppend(stored, transcript);
    if (fresh === null || fresh.length === 0) return 0;
    const firstIndex = nextImportedMessageIndex(records.messages.map((message) => message.id));
    const lastAt = DateTime.makeUnsafe(fresh.at(-1)!.createdAt);
    const events: Array<OrchestrationV2DomainEvent> = [
      ...fresh.flatMap((message, offset) =>
        AgentSessionImporter.messageEvents({ threadId, index: firstIndex + offset, message }),
      ),
      {
        id: EventId.make(
          `${AgentSessionImporter.IMPORT_EVENT_PREFIX}:thread:${threadId}:live-sync:${firstIndex + fresh.length}`,
        ),
        type: "thread.metadata-updated",
        threadId,
        providerInstanceId: records.thread.providerInstanceId,
        occurredAt: lastAt,
        payload: { ...records.thread, updatedAt: lastAt },
      },
    ];
    yield* eventSink.write({ events });
    return fresh.length;
  });

  const followThread = Effect.fn("AgentSessionLiveSync.followThread")(function* (
    threadId: ThreadId,
    source: AgentSessionImportSource,
  ) {
    const stats = yield* fs.stat(source.filePath).pipe(Effect.option);
    if (Option.isNone(stats)) {
      stopped.add(threadId);
      return 0;
    }
    const size = Number(stats.value.size);
    const mtimeMs = Option.match(stats.value.mtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    });
    const key = `${size}:${mtimeMs}`;
    if (!handled.has(threadId)) handled.set(threadId, `${source.size}:${source.mtimeMs}`);
    if (handled.get(threadId) === key) return 0;
    if (size > MAX_FOLLOWED_BYTES) {
      stopped.add(threadId);
      return 0;
    }
    const contents = yield* fs.readFileString(source.filePath);
    const parsed = parseAgentSessionTranscript({
      source: source.provider,
      providerInstanceId: source.providerInstanceId,
      fallbackSessionId: source.providerSessionId,
      lastActiveAtMs: mtimeMs ?? 0,
      contents,
    });
    const appended =
      parsed === null
        ? 0
        : yield* threadCommands.withLock(threadId, append(threadId, parsed.messages));
    // null: not read this time (a turn was running), so the same file is tried again.
    if (appended !== null) handled.set(threadId, key);
    return appended ?? 0;
  });

  /** One pass: follow every imported conversation, and now and then look for new ones. */
  const sweep = Effect.fn("AgentSessionLiveSync.sweep")(function* () {
    sweeps += 1;
    const discover = sweeps % DISCOVERY_EVERY_SWEEPS === 1;
    const rows = yield* runtimes.list();
    const importedThreads: Array<ThreadId> = [];
    let appended = 0;
    for (const row of rows) {
      const sources = decodeImportedTranscriptPayload(row.runtimePayload).pipe(
        Option.flatMapNullishOr((payload) => payload.importedTranscripts),
        Option.getOrElse((): ReadonlyArray<AgentSessionImportSource> => []),
      );
      if (sources.length === 0) continue;
      importedThreads.push(row.threadId);
      if (stopped.has(row.threadId)) continue;
      const source = sources.findLast((entry) => FOLLOWED_SOURCES.has(entry.provider));
      if (source === undefined) continue;
      appended += yield* followThread(row.threadId, source).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not follow an imported conversation", {
            threadId: row.threadId,
            cause,
          }).pipe(Effect.as(0)),
        ),
      );
    }
    let discoveredProjects = 0;
    if (discover) {
      // Only projects the user already imported from: importing is their opt-in.
      const projectIds = new Set<ProjectId>();
      for (const threadId of importedThreads) {
        const records = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
        if (Option.isSome(records)) projectIds.add(records.value.thread.projectId);
      }
      for (const projectId of projectIds) {
        yield* importer.importRecentAgentThreads({ projectId }).pipe(
          Effect.tap(() => Effect.sync(() => (discoveredProjects += 1))),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not look for new conversations", { projectId, cause }),
          ),
        );
      }
    }
    return { appended, discoveredProjects } satisfies SyncResult;
  });

  return { sweep };
});

export class AgentSessionLiveSync extends Context.Service<
  AgentSessionLiveSync,
  Effect.Success<typeof make>
>()("t3/sessionSync/AgentSessionLiveSync") {}

export const layerService = Layer.effect(AgentSessionLiveSync, make);

/** Runs the sweep on the shared scheduler's tick. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* AgentSessionLiveSync;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("agent-session-live-sync", sync.sweep());
  }),
).pipe(Layer.provide(layerService));
