import {
  CheckpointScopeId,
  CommandId,
  EventId,
  PmError,
  type PmT3ImportMode,
  type PmT3ImportResult,
  type PmT3Status,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { checkpointRefForScopeOrdinal } from "../../orchestration-v2/CheckpointService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { EVENT_LOG_PRUNED_THROUGH } from "../../persistence/OrchestrationEventStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { PmService } from "../PmService.ts";
import { pmVisibility } from "../PmVisibility.ts";
import {
  readSyncState,
  setSyncEnabled,
  syncProjects,
  syncProjectsAtLaunch,
  t3ScratchRoots,
} from "./PmT3Sync.ts";
import { readTables, resolveT3Source, snapshotDatabase, type T3Source } from "./T3Source.ts";

// t3code-pm: copies T3 Code's threads into PM3code, one way. Imported threads get new ids, and
// their checkpoint refs are copied under those ids, so nothing PM3code later does to a thread
// (continue it, roll it back, delete it) can touch a ref T3 Code still uses.

const THREADS_TABLE = "orchestration_v2_projection_threads";
const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const BINDINGS_TABLE = "orchestration_v2_projection_provider_session_bindings";
const SCOPES_TABLE = "orchestration_v2_projection_checkpoint_scopes";
const CONTEXT_TRANSFERS_TABLE = "orchestration_v2_projection_context_transfers";
const V1_CHECKPOINT_REFS = "refs/t3/checkpoints";

/** Running state never comes over, as in migrate-dev-db: it belongs to the T3 Code that runs it. */
const NOT_COPIED = new Set([
  "provider_session_runtime",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_v2_command_receipts",
  "orchestration_v2_legacy_imports",
  "scheduled_tasks",
]);
// Upstream's pre-V2 tables: the legacy importer would read rows there as threads to import again.
const isLegacyTable = (name: string) =>
  name.startsWith("projection_") && name !== "projection_projects";
const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "restart-continuations",
  "subagent-results",
  "delegated-completions",
  "unread-steers",
];
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];
const PM_THREAD_TABLES = [
  "pm_threads",
  "pm_workers",
  "pm_items",
  "pm_item_steps",
  "pm_item_waits",
  "pm_asks",
  "pm_links",
  "pm_memory",
  "pm_reports",
  "pm_pages",
  "pm_retired_threads",
  "pm_t3_imported_threads",
];

const latestKnownMigration = Math.max(...migrationManifest.map(([id]) => id));

const isPmError = Schema.is(PmError);
const conflict = (message: string) => new PmError({ code: "conflict", message });
const unavailable = (message: string) => () => new PmError({ code: "unavailable", message });

type Row = Record<string, unknown>;

/** Every ref of a v2 checkpoint scope, which CheckpointService names by a digest of the scope id. */
const scopeRefPrefix = (scopeId: string) =>
  checkpointRefForScopeOrdinal({
    scopeId: CheckpointScopeId.make(scopeId),
    ordinalWithinScope: 0,
  }).pipe(Effect.map((ref) => ref.slice(0, -"ordinal/0".length)));
const legacyRefPrefix = (threadId: string) =>
  `${V1_CHECKPOINT_REFS}/${Base64Url.encode(threadId)}/turn/`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrites every id in `pairs` wherever it appears, including inside composite ids. */
function makeIdRemap(pairs: ReadonlyMap<string, string>) {
  const expanded = new Map<string, string>();
  for (const [from, to] of pairs) {
    // Composite ids embed parts with encodeURIComponent, sometimes twice.
    let a = from;
    let b = to;
    for (let depth = 0; depth < 3; depth += 1) {
      expanded.set(a, b);
      a = encodeURIComponent(a);
      b = encodeURIComponent(b);
    }
  }
  if (expanded.size === 0) return (value: unknown) => value;
  const pattern = new RegExp(
    [...expanded.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  return (value: unknown) =>
    typeof value === "string" ? value.replace(pattern, (found) => expanded.get(found)!) : value;
}

interface SnapshotData {
  readonly migration: number;
  readonly threads: ReadonlyArray<Row>;
  readonly live: ReadonlySet<string>;
  readonly tables: ReadonlyMap<string, ReadonlyArray<Row>>;
}

/** Projection payloads are JSON the server wrote; a row that does not parse reads as empty. */
const payloadOf = (row: Row): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(String(row.payload_json));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const isDeleted = (row: Row) => {
  if (row.deleted_at !== null && row.deleted_at !== undefined) return true;
  return payloadOf(row).deletedAt != null;
};
const rootOf = (row: Row) => {
  const lineage = payloadOf(row).lineage as { rootThreadId?: unknown } | undefined;
  return typeof lineage?.rootThreadId === "string" ? lineage.rootThreadId : String(row.thread_id);
};
const textOf = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pm = yield* PmService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projectService = yield* ProjectService.ProjectService;
  const lock = yield* Semaphore.make(1);
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
    | ProjectService.ProjectService
    | Digest.Digest
  >();

  const sqlError = (operation: string) => (cause: unknown) =>
    Effect.logWarning("PM3code T3 import step failed", { operation, cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new PmError({ code: "unavailable", message: `Import failed while ${operation}.` }),
        ),
      ),
    );

  const toPmErrorEarly = (operation: string) => (error: unknown) =>
    isPmError(error) ? Effect.fail(error) : sqlError(operation)(error);

  const pmNoProject = managedFolders.ensureScratchProject.pipe(
    Effect.map(({ projectId }) => Option.some<string>(projectId)),
    Effect.catchCause((cause) =>
      Effect.logWarning("PM3code has no No project for T3 Code's", { cause }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );

  const source = resolveT3Source(config.baseDir).pipe(
    Effect.filterOrFail(
      (found): found is T3Source => found !== null,
      () =>
        new PmError({
          code: "not_found",
          message: "T3 Code's data was not found (~/.t3/userdata). Nothing to import.",
        }),
    ),
  );

  const pmThreadCount = sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.deletedAt') IS NULL`.pipe(
    Effect.map((rows) => Number(rows[0]?.count ?? 0)),
  );

  const status = Effect.gen(function* () {
    const sync = yield* readSyncState(config.stateDir);
    const found = yield* resolveT3Source(config.baseDir);
    let t3: PmT3Status["source"] = null;
    if (found !== null && (yield* fs.exists(found.dbPath))) {
      const scratch = path.join(config.stateDir, `pm-t3-status-${yield* randomUuidV4}.sqlite`);
      const tables = yield* readTables(found.dbPath, scratch, [
        "effect_sql_migrations",
        "projection_projects",
        THREADS_TABLE,
      ]).pipe(Effect.option);
      if (tables._tag === "Some") {
        const migration = Math.max(
          0,
          ...tables.value.effect_sql_migrations.map((row) => Number(row.migration_id)),
        );
        t3 = {
          home: found.home,
          threads: tables.value[THREADS_TABLE].filter((row) => !isDeleted(row)).length,
          projects: tables.value.projection_projects.filter((row) => !row.deleted_at).length,
          newer: migration > latestKnownMigration,
        };
      }
    }
    const [imported] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM pm_t3_imported_threads`;
    return {
      syncEnabled: sync.enabled,
      lastLaunch: sync.lastLaunch,
      source: t3,
      pmThreads: yield* pmThreadCount,
      importedThreads: Number(imported?.count ?? 0),
    } satisfies PmT3Status;
  });

  /** Snapshot, upgrade and read what can be imported; T3 Code's own file is only read. */
  const readSnapshot = Effect.fn("PmT3Import.readSnapshot")(function* (found: T3Source) {
    const snapshotPath = path.join(config.stateDir, "pm-t3-import.sqlite");
    yield* snapshotDatabase(found.dbPath, snapshotPath).pipe(
      Effect.mapError(unavailable("Could not copy T3 Code's database.")),
    );
    return yield* Effect.gen(function* () {
      const snapshot = yield* SqlClient.SqlClient;
      const ledger = yield* snapshot<{ id: number | null }>`
        SELECT MAX(migration_id) AS id FROM effect_sql_migrations`.pipe(
        Effect.orElseSucceed(() => [{ id: 0 }]),
      );
      const migration = Number(ledger[0]?.id ?? 0);
      if (migration > latestKnownMigration) {
        return yield* conflict(
          `T3 Code's database is newer (schema ${migration}) than this PM3code understands (schema ${latestKnownMigration}). Update PM3code, then import again. Nothing was changed.`,
        );
      }
      yield* snapshot.unsafe("PRAGMA foreign_keys = ON").unprepared;
      yield* runMigrations().pipe(
        Effect.mapError(unavailable("Could not upgrade the copy of T3 Code's database.")),
      );
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const live = new Set<string>();
      for (const kind of RECOVERY_KINDS) {
        for (const id of yield* store.getRecoveryThreadIds(kind)) live.add(id);
      }
      for (const row of yield* snapshot<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_runs
        WHERE status IN ${snapshot.in(ACTIVE_RUN_STATUSES)}
        UNION SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL`)
        live.add(row.thread_id);
      const names = yield* snapshot<{ name: string }>`
        SELECT DISTINCT m.name FROM sqlite_master m, pragma_table_info(m.name) c
        WHERE m.type = 'table' AND (c.name = 'thread_id' OR m.name = ${CONTEXT_TRANSFERS_TABLE})`;
      // Tables a trigger writes (item counts, search) rebuild themselves as the rows go in.
      const derived = new Set(
        (yield* snapshot<{ sql: string | null }>`
          SELECT sql FROM sqlite_master WHERE type = 'trigger'`).flatMap((row) =>
          [
            ...(row.sql ?? "").matchAll(
              /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/gi,
            ),
          ].map((match) => match[1]!.toLowerCase()),
        ),
      );
      const tables = new Map<string, ReadonlyArray<Row>>();
      for (const { name } of names) {
        if (NOT_COPIED.has(name) || isLegacyTable(name) || name.startsWith("pm_")) continue;
        if (derived.has(name.toLowerCase())) continue;
        tables.set(name, yield* snapshot.unsafe<Row>(`SELECT * FROM "${name}"`));
      }
      return {
        migration,
        threads: tables.get(THREADS_TABLE) ?? [],
        live,
        tables,
      } satisfies SnapshotData;
    }).pipe(
      // Fresh: the server's memoized ProjectionStore reads PM3code's own database.
      Effect.provide(
        Layer.fresh(ProjectionStore.layer).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: snapshotPath })),
        ),
      ),
      Effect.catch(toPmErrorEarly("reading the copy of T3 Code's database")),
      Effect.ensuring(
        Effect.forEach(["", "-wal", "-shm"], (suffix) =>
          fs.remove(`${snapshotPath}${suffix}`, { force: true }).pipe(Effect.ignore),
        ),
      ),
    );
  });

  const liveColumns = Effect.fn("PmT3Import.liveColumns")(function* () {
    const rows = yield* sql<{ table_name: string; column_name: string }>`
      SELECT m.name AS table_name, c.name AS column_name
      FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table'`;
    const columns = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = columns.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      columns.set(row.table_name, set);
    }
    return columns;
  });

  /** Removes every PM3code thread for Replace. Rows only: refs and worktrees stay for the backup. */
  const removeAllThreads = Effect.fn("PmT3Import.removeAllThreads")(function* () {
    const columns = yield* liveColumns();
    const removed = yield* pmThreadCount;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const [table, cols] of columns) {
          if (table === "scheduled_tasks" || table.startsWith("pm_")) continue;
          if (cols.has("thread_id")) yield* sql.unsafe(`DELETE FROM "${table}"`).unprepared;
        }
        yield* sql`DELETE FROM ${sql(CONTEXT_TRANSFERS_TABLE)}`;
        yield* sql`DELETE FROM ${sql(PROVIDER_SESSIONS_TABLE)}`;
        yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind = 'thread'`;
        yield* sql`DELETE FROM orchestration_command_receipts WHERE aggregate_kind = 'thread'`;
        for (const table of PM_THREAD_TABLES) {
          if (columns.has(table)) yield* sql.unsafe(`DELETE FROM "${table}"`).unprepared;
        }
      }),
    );
    pmVisibility.reset(yield* pm.isEnabled, []);
    return removed;
  });

  const backupDatabase = Effect.fn("PmT3Import.backup")(function* () {
    const dir = path.join(config.stateDir, "backups");
    yield* fs.makeDirectory(dir, { recursive: true });
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `statev2-before-t3-replace-${stamp}.sqlite`);
    yield* sql`VACUUM INTO ${backupPath}`;
    yield* fs.chmod(backupPath, 0o600).pipe(Effect.ignore);
    return backupPath;
  });

  /** Copies each scope's refs (and the legacy per-thread refs) under the new ids. */
  const copyRefs = Effect.fn("PmT3Import.copyRefs")(function* (
    copies: ReadonlyArray<{
      readonly cwds: ReadonlyArray<string>;
      readonly prefixes: ReadonlyArray<readonly [from: string, to: string]>;
    }>,
  ) {
    let copied = 0;
    let failed = 0;
    for (const copy of copies) {
      const result = yield* Effect.gen(function* () {
        let cwd: string | undefined;
        for (const candidate of copy.cwds) {
          if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
            cwd = candidate;
            break;
          }
        }
        if (cwd === undefined) return 0;
        let count = 0;
        for (const [from, to] of copy.prefixes) {
          const listed = yield* git.execute({
            operation: "PmT3Import.listCheckpointRefs",
            cwd,
            args: ["for-each-ref", "--format=%(objectname) %(refname)", from],
            allowNonZeroExit: true,
            maxOutputBytes: 16 * 1024 * 1024,
          });
          if (listed.exitCode !== 0) continue;
          const lines = listed.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => {
              const [sha, ref] = line.split(" ");
              return `update ${to}${ref!.slice(from.length)} ${sha}\n`;
            });
          if (lines.length === 0) continue;
          yield* git.execute({
            operation: "PmT3Import.copyCheckpointRefs",
            cwd,
            args: ["update-ref", "--stdin"],
            stdin: lines.join(""),
          });
          count += lines.length;
        }
        return count;
      }).pipe(Effect.result);
      if (result._tag === "Success") copied += result.success;
      else {
        failed += 1;
        yield* Effect.logWarning("Could not copy T3 Code checkpoint refs", {
          cause: result.failure,
        });
      }
    }
    return { copied, failed };
  });

  const runImport = Effect.fn("PmT3Import.run")(function* (mode: PmT3ImportMode) {
    const found = yield* source;
    if (!(yield* fs.exists(found.dbPath))) {
      return yield* new PmError({ code: "not_found", message: "T3 Code has no database yet." });
    }
    const snapshot = yield* readSnapshot(found);
    const pmBefore = yield* pmThreadCount;
    const t3Visible = snapshot.threads.filter((row) => !isDeleted(row));

    let backupPath: string | null = null;
    let removed = 0;
    if (mode === "replace") {
      const [active] = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs
        WHERE status IN ${sql.in(ACTIVE_RUN_STATUSES)}`;
      if (Number(active?.count ?? 0) > 0) {
        return yield* conflict(
          "Some PM3code threads are still running. Stop them, then replace. Nothing was changed.",
        );
      }
      backupPath = yield* backupDatabase();
      removed = yield* removeAllThreads();
    }

    const projects = yield* syncProjects({
      config,
      dbPath: found.dbPath,
      t3Home: found.home,
      pmNoProject,
      respectSeen: false,
    }).pipe(Effect.provide(context));
    const already = new Set(
      (yield* sql<{ source_thread_id: string }>`
        SELECT source_thread_id FROM pm_t3_imported_threads`).map((row) => row.source_thread_id),
    );

    // Whole families (a thread with its forks and subagents) or nothing, as migrate-dev-db keeps them.
    const families = new Map<string, Array<Row>>();
    for (const row of t3Visible) {
      const root = rootOf(row);
      families.set(root, [...(families.get(root) ?? []), row]);
    }
    let skippedRunning = 0;
    let skippedAlreadyImported = 0;
    let skippedNoProject = 0;
    const accepted: Array<Array<Row>> = [];
    for (const family of families.values()) {
      const ids = family.map((row) => String(row.thread_id));
      if (ids.some((id) => already.has(id))) skippedAlreadyImported += family.length;
      else if (ids.some((id) => snapshot.live.has(id))) skippedRunning += family.length;
      else if (family.some((row) => !projects.idMap.has(String(row.project_id))))
        skippedNoProject += family.length;
      else accepted.push(family);
    }

    const idPairs = new Map<string, string>();
    for (const family of accepted) {
      for (const row of family) idPairs.set(String(row.thread_id), yield* randomUuidV4);
    }
    const projectPairs = new Map(
      [...projects.idMap].filter(([from, to]) => from !== to && !idPairs.has(from)),
    );
    const remap = makeIdRemap(new Map([...idPairs, ...projectPairs]));
    const columns = yield* liveColumns();
    const at = DateTime.formatIso(yield* DateTime.now);

    const rowsFor = (table: string, threadIds: ReadonlySet<string>) => {
      const rows = snapshot.tables.get(table) ?? [];
      if (table === CONTEXT_TRANSFERS_TABLE) {
        return rows.filter(
          (row) =>
            threadIds.has(String(row.source_thread_id)) &&
            idPairs.has(String(row.target_thread_id)),
        );
      }
      if (table === PROVIDER_SESSIONS_TABLE) {
        const bound = new Set(
          (snapshot.tables.get(BINDINGS_TABLE) ?? [])
            .filter((row) => threadIds.has(String(row.thread_id)))
            .map((row) => String(row.provider_session_id)),
        );
        return rows.filter(
          (row) =>
            threadIds.has(String(row.thread_id)) || bound.has(String(row.provider_session_id)),
        );
      }
      return rows.filter((row) => threadIds.has(String(row.thread_id)));
    };

    let imported = 0;
    let skippedConflicts = 0;
    const importedIds: Array<string> = [];
    const refCopies: Array<{
      cwds: ReadonlyArray<string>;
      prefixes: ReadonlyArray<readonly [string, string]>;
    }> = [];
    for (const family of accepted) {
      const threadIds = new Set(family.map((row) => String(row.thread_id)));
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const [table] of snapshot.tables) {
              const live = columns.get(table);
              if (live === undefined) continue;
              for (const row of rowsFor(table, threadIds)) {
                const keys = Object.keys(row).filter((key) => live.has(key));
                yield* sql.unsafe(
                  `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(", ")}) VALUES (${keys
                    .map(() => "?")
                    .join(", ")})`,
                  keys.map((key) => remap(row[key])),
                ).unprepared;
              }
            }
            for (const id of threadIds) {
              yield* sql`INSERT INTO pm_t3_imported_threads (thread_id, source_thread_id, imported_at)
                VALUES (${idPairs.get(id)!}, ${id}, ${at})`;
            }
          }),
        )
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        skippedConflicts += family.length;
        yield* Effect.logWarning("Skipped a T3 Code thread family", { cause: result.failure });
        continue;
      }
      imported += family.length;
      for (const row of family) {
        const from = String(row.thread_id);
        const to = idPairs.get(from)!;
        importedIds.push(to);
        const worktreePath = textOf(payloadOf(row).worktreePath);
        const project = (yield* sql<{ workspace_root: string }>`
          SELECT workspace_root FROM projection_projects
          WHERE project_id = ${projects.idMap.get(String(row.project_id))!}`)[0];
        const scopes = (snapshot.tables.get(SCOPES_TABLE) ?? []).filter(
          (scope) => String(scope.thread_id) === from,
        );
        const cwds = (cwd: unknown) =>
          [cwd, worktreePath, project?.workspace_root].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          );
        refCopies.push({
          cwds: cwds(undefined),
          prefixes: [[legacyRefPrefix(from), legacyRefPrefix(to)]],
        });
        for (const scope of scopes) {
          const scopeId = String(scope.scope_id);
          refCopies.push({
            cwds: cwds(textOf(payloadOf(scope).cwd)),
            prefixes: [
              [yield* scopeRefPrefix(scopeId), yield* scopeRefPrefix(String(remap(scopeId)))],
            ],
          });
        }
      }
    }

    // A live update per thread, so connected clients show them without reconnecting.
    for (const threadId of importedIds) {
      const occurredAt = yield* DateTime.now;
      const eventSuffix = yield* randomUuidV4;
      yield* projections.getThread(ThreadId.make(threadId)).pipe(
        Effect.flatMap((thread) =>
          eventSink.write({
            events: [
              {
                id: EventId.make(`event:pm-t3-import:${threadId}:${eventSuffix}`),
                type: "thread.metadata-updated",
                threadId: thread.id,
                providerInstanceId: thread.providerInstanceId,
                occurredAt,
                payload: thread,
              },
            ],
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not announce an imported thread", { threadId, cause }),
        ),
      );
    }
    if (mode === "replace") {
      // Clients that resume from before the replace load a fresh list instead of keeping removed rows.
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
        VALUES (${EVENT_LOG_PRUNED_THROUGH}, ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0), ${at})
        ON CONFLICT(projection_name) DO UPDATE SET
          last_sequence = MAX(last_sequence, excluded.last_sequence), updated_at = excluded.updated_at`;
      yield* pm.changed("*");
    }
    const refs = yield* copyRefs(refCopies);
    return {
      mode,
      before: { pmThreads: pmBefore, t3Threads: t3Visible.length },
      after: { pmThreads: yield* pmThreadCount },
      imported,
      removed,
      skippedRunning,
      skippedAlreadyImported,
      skippedNoProject,
      skippedConflicts,
      projectsAdded: projects.added,
      checkpointRefsCopied: refs.copied,
      checkpointRefsFailed: refs.failed,
      backupPath,
    } satisfies PmT3ImportResult;
  });

  /**
   * Earlier imports copied T3 Code's No project as an ordinary project at T3's scratch folder.
   * Moves its threads into PM3code's No project, keeping each one's folder, then removes it.
   */
  const repairImportedNoProject = Effect.gen(function* () {
    const found = yield* resolveT3Source(config.baseDir);
    if (found === null) return;
    const t3Scratch = yield* t3ScratchRoots(found.home);
    const stray = (yield* sql<{ project_id: string; workspace_root: string }>`
      SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL`).filter(
      (row) => t3Scratch.has(path.resolve(row.workspace_root)),
    );
    if (stray.length === 0) return;
    const target = yield* pmNoProject;
    if (Option.isNone(target)) return;
    for (const project of stray) {
      if (project.project_id === target.value) continue;
      const threadIds = (yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE project_id = ${project.project_id} AND deleted_at IS NULL`).map(
        (row) => row.thread_id,
      );
      const [active] = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs
        WHERE thread_id IN ${sql.in(threadIds.length > 0 ? threadIds : [""])}
          AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}`;
      // A running thread rewrites its own metadata; the next launch moves them once it is idle.
      if (Number(active?.count ?? 0) > 0) continue;
      for (const threadId of threadIds) {
        const thread = yield* projections.getThread(ThreadId.make(threadId));
        const occurredAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`event:pm-t3-no-project:${threadId}:${yield* randomUuidV4}`),
              type: "thread.metadata-updated",
              threadId: thread.id,
              providerInstanceId: thread.providerInstanceId,
              occurredAt,
              payload: {
                ...thread,
                projectId: ProjectId.make(target.value),
                worktreePath: thread.worktreePath ?? project.workspace_root,
                updatedAt: occurredAt,
              },
            },
          ],
        });
      }
      yield* sql`UPDATE pm_threads SET project_id = ${target.value}
        WHERE project_id = ${project.project_id}`;
      yield* projectService.delete({
        commandId: CommandId.make(`command:pm-t3-no-project:${yield* randomUuidV4}`),
        projectId: ProjectId.make(project.project_id),
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not move T3 Code's No project into PM3code's", { cause }),
    ),
  );

  const toPmError = (operation: string) => (error: unknown) =>
    isPmError(error) ? Effect.fail(error) : sqlError(operation)(error);

  return {
    status: status.pipe(
      Effect.catch(toPmError("reading the import status")),
      Effect.provide(context),
    ),
    setSyncEnabled: (enabled: boolean) =>
      setSyncEnabled(config.stateDir, enabled).pipe(
        Effect.andThen(status),
        Effect.catch(toPmError("saving the setting")),
        Effect.provide(context),
      ),
    importThreads: (mode: PmT3ImportMode) =>
      lock.withPermits(1)(
        runImport(mode).pipe(Effect.catch(toPmError("copying threads")), Effect.provide(context)),
      ),
    syncProjectsAtLaunch: repairImportedNoProject.pipe(
      Effect.andThen(
        syncProjectsAtLaunch({ baseDir: config.baseDir, stateDir: config.stateDir }, pmNoProject),
      ),
      Effect.provide(context),
    ),
  };
});

export class PmT3Import extends Context.Service<PmT3Import, Effect.Success<typeof make>>()(
  "t3/pm/t3/PmT3Import",
) {}

export const layer = Layer.effect(PmT3Import, make);
