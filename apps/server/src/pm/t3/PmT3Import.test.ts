import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { checkpointRefForScopeOrdinal } from "../../orchestration-v2/CheckpointService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts"; // pipelines:
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { layerFakes, makeWorld } from "../Pm.testkit.ts";
import * as PmLayer from "../PmLayer.ts";
import { PmT3Import } from "./PmT3Import.ts";
import { readSyncState, SYNC_STATE_FILE, syncSettingsAtLaunch } from "./PmT3Sync.ts";
import { T3_HOME_ENV } from "./T3Source.ts";

const T3_THREAD = "6d1f3c4e-0000-4000-8000-00000000t3aa";
const T3_PROJECT = "project-from-t3";
const INSTANCE = ProviderInstanceId.make("codex");

const NO_ENRICHMENT = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: true,
};

const layerBase = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const layerPmServer = PmLayer.layer.pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provideMerge(
    Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
      invalidate: () => Effect.void,
      getAvailable: () => Effect.succeed(NO_ENRICHMENT),
      peek: () => Effect.succeed(NO_ENRICHMENT),
    }),
  ),
  Layer.provideMerge(Layer.merge(RuntimeLayer.layerEventSink, ProjectionStore.layer)),
  Layer.provideMerge(Layer.merge(GitVcsDriver.layer, WorkspacePaths.layer)),
  Layer.provideMerge(layerFakes(makeWorld())),
  // pipelines: the router reads providers; this test has none.
  Layer.provideMerge(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pm-t3-import-" })),
  Layer.provideMerge(layerBase),
);

const threadOf = (
  id: string,
  projectId: string,
  title: string,
  at: DateTime.Utc,
): OrchestrationV2AppThread => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  title,
  providerInstanceId: INSTANCE,
  modelSelection: { instanceId: INSTANCE, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** A thread with one message, written the way the server writes projections. */
const putThread = (input: { id: string; projectId: string; title: string; text: string }) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const thread = threadOf(input.id, input.projectId, input.title, now);
    yield* store.apply({
      id: EventId.make(`event:thread:${input.id}`),
      type: "thread.created",
      threadId: thread.id,
      occurredAt: now,
      payload: thread,
    });
    yield* store.apply({
      id: EventId.make(`event:message:${input.id}`),
      type: "message.updated",
      threadId: thread.id,
      occurredAt: now,
      payload: {
        id: MessageId.make(`message:${input.id}`),
        threadId: thread.id,
        runId: null,
        nodeId: null,
        role: "user",
        text: input.text,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    });
  });

/** A T3 Code home holding one project (a real repo with checkpoint refs) and one thread. */
const makeT3Home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "fake-t3-home-" });
  const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-repo-" }));
  const run = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "pm-t3-test", cwd: repo, args });
  yield* run(["init", "-b", "main"]);
  yield* run(["config", "user.email", "t3@example.test"]);
  yield* run(["config", "user.name", "T3 test"]);
  yield* fs.writeFileString(`${repo}/file.txt`, "one\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);

  const dbPath = `${home}/userdata/statev2.sqlite`;
  yield* fs.makeDirectory(`${home}/userdata`, { recursive: true });
  const scopeId = CheckpointScopeId.make(`checkpoint-scope:thread:${T3_THREAD}:name:root`);
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO projection_projects ${sql.insert({
      project_id: T3_PROJECT,
      title: "From T3",
      workspace_root: repo,
      scripts_json: "[]",
      created_at: now,
      updated_at: now,
    })}`;
    yield* putThread({ id: T3_THREAD, projectId: T3_PROJECT, title: "T3 thread", text: "hello" });
    // A trigger keeps the item counts; copying the counts as well would double them.
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
      turn_item_id: `item:${T3_THREAD}`,
      thread_id: T3_THREAD,
      run_id: `run:${T3_THREAD}`,
      ordinal: 1,
      type: "assistant_message",
      status: "completed",
      updated_at: now,
      payload_json: "{}",
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes ${sql.insert({
      scope_id: scopeId,
      thread_id: T3_THREAD,
      node_id: `node:${T3_THREAD}`,
      kind: "root_run",
      ordinal_within_parent: 0,
      advances_app_run_count: 1,
      created_at: now,
      payload_json: JSON.stringify({ cwd: repo }),
    })}`;
  }).pipe(
    Effect.provide(
      Layer.fresh(ProjectionStore.layer).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
      ),
    ),
  );
  const t3Refs = [
    yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 }),
    yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 1 }),
    `refs/t3/checkpoints/${Base64Url.encode(T3_THREAD)}/turn/1`,
  ];
  for (const ref of t3Refs) yield* run(["update-ref", ref, "HEAD"]);
  const listRefs = run(["for-each-ref", "--format=%(refname)", "refs/t3/"]).pipe(
    Effect.map(({ stdout }) => stdout.trim().split("\n").filter(Boolean).sort()),
  );
  return { home, repo, dbPath, t3Refs: t3Refs.sort(), listRefs, run };
});

const withT3Home = (home: string) =>
  Effect.provideService(HostProcess.Environment, { ...process.env, [T3_HOME_ENV]: home });

const pmThreads = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ thread_id: string; title: string }>`
    SELECT thread_id, title FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
    ORDER BY title`,
);

describe("launch read", () => {
  it.live(
    "adds T3 Code's settings the person has not changed in PM3code, and skips a missing home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const t3 = yield* fs.makeTempDirectoryScoped({ prefix: "fake-t3-settings-" });
        const pmHome = yield* fs.makeTempDirectoryScoped({ prefix: "pm-home-" });
        const pm = { baseDir: pmHome, stateDir: `${pmHome}/userdata` };
        yield* fs.makeDirectory(`${t3}/userdata`, { recursive: true });
        yield* fs.makeDirectory(pm.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${t3}/userdata/client-settings.json`,
          JSON.stringify({ fontSizeInterface: 15, mathRenderingEnabled: true }),
        );
        // Changed in PM3code before any launch read: PM3code's value stays.
        yield* fs.writeFileString(
          `${pm.stateDir}/client-settings.json`,
          JSON.stringify({ fontSizeInterface: 17 }),
        );
        yield* syncSettingsAtLaunch(pm).pipe(withT3Home(t3));
        const merged = JSON.parse(yield* fs.readFileString(`${pm.stateDir}/client-settings.json`));
        assert.strictEqual(merged.fontSizeInterface, 17);
        assert.strictEqual(merged.mathRenderingEnabled, true);

        // A later launch: T3 Code's new value reaches the setting PM3code never changed.
        yield* fs.writeFileString(
          `${t3}/userdata/client-settings.json`,
          JSON.stringify({ fontSizeInterface: 15, mathRenderingEnabled: false }),
        );
        yield* syncSettingsAtLaunch(pm).pipe(withT3Home(t3));
        const again = JSON.parse(yield* fs.readFileString(`${pm.stateDir}/client-settings.json`));
        assert.strictEqual(again.fontSizeInterface, 17);
        assert.isUndefined(again.mathRenderingEnabled);

        // No T3 Code at all: nothing is written but the note that it was skipped.
        const missing = { baseDir: pmHome, stateDir: `${pmHome}/other` };
        yield* fs.makeDirectory(missing.stateDir, { recursive: true });
        yield* syncSettingsAtLaunch(missing).pipe(withT3Home(`${t3}/does-not-exist`));
        assert.deepStrictEqual(yield* fs.readDirectory(missing.stateDir), [SYNC_STATE_FILE]);
        assert.strictEqual((yield* readSyncState(missing.stateDir)).lastLaunch?.skipped, "missing");

        // The switch: off means T3 Code is not read at all.
        yield* fs.writeFileString(
          `${t3}/userdata/client-settings.json`,
          JSON.stringify({ mathRenderingEnabled: true, fontSizeInterface: 15 }),
        );
        const state = yield* readSyncState(pm.stateDir);
        yield* fs.writeFileString(
          `${pm.stateDir}/${SYNC_STATE_FILE}`,
          JSON.stringify({ ...state, enabled: false }),
        );
        yield* syncSettingsAtLaunch(pm).pipe(withT3Home(t3));
        const off = JSON.parse(yield* fs.readFileString(`${pm.stateDir}/client-settings.json`));
        assert.isUndefined(off.mathRenderingEnabled);
      }).pipe(Effect.scoped, Effect.provide(layerBase)),
  );

  it.live("adds T3 Code's projects by folder and never adds one twice", () =>
    Effect.gen(function* () {
      const t3 = yield* makeT3Home;
      const service = yield* PmT3Import;
      yield* service.syncProjectsAtLaunch.pipe(withT3Home(t3.home));
      const sql = yield* SqlClient.SqlClient;
      const projects = yield* sql<{ project_id: string; workspace_root: string }>`
        SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL`;
      assert.deepStrictEqual(projects, [{ project_id: T3_PROJECT, workspace_root: t3.repo }]);
      yield* service.syncProjectsAtLaunch.pipe(withT3Home(t3.home));
      const again = yield* sql`SELECT project_id FROM projection_projects`;
      assert.strictEqual(again.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layerPmServer)),
  );
});

describe("import from T3 Code", () => {
  it.live("copies threads under new ids, copies their refs, and never doubles a thread", () =>
    Effect.gen(function* () {
      const t3 = yield* makeT3Home;
      const service = yield* PmT3Import;
      const result = yield* service.importThreads("import").pipe(withT3Home(t3.home));
      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.before.pmThreads, 0);
      assert.strictEqual(result.after.pmThreads, 1);
      assert.strictEqual(result.projectsAdded, 1);
      assert.isNull(result.backupPath);

      const [copy] = yield* pmThreads;
      assert.strictEqual(copy?.title, "T3 thread");
      assert.notStrictEqual(copy?.thread_id, T3_THREAD);
      const sql = yield* SqlClient.SqlClient;
      const messages = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_messages`;
      assert.deepStrictEqual(messages, [{ thread_id: copy!.thread_id }]);
      const counts = yield* sql<{ thread_id: string; item_count: number }>`
        SELECT thread_id, item_count FROM orchestration_v2_projection_turn_item_counts`;
      assert.deepStrictEqual(counts, [{ thread_id: copy!.thread_id, item_count: 1 }]);

      // The copy's refs exist beside T3 Code's, under its own names.
      const refs = yield* t3.listRefs;
      assert.strictEqual(result.checkpointRefsCopied, 3);
      assert.includeMembers(refs, t3.t3Refs);
      assert.strictEqual(refs.length, 6);

      const second = yield* service.importThreads("import").pipe(withT3Home(t3.home));
      assert.strictEqual(second.imported, 0);
      assert.strictEqual(second.skippedAlreadyImported, 1);
      assert.strictEqual((yield* pmThreads).length, 1);
    }).pipe(Effect.scoped, Effect.provide(layerPmServer)),
  );

  it.live("deleting an imported thread in PM3code cannot reach T3 Code's checkpoint refs", () =>
    Effect.gen(function* () {
      const t3 = yield* makeT3Home;
      const service = yield* PmT3Import;
      yield* service.importThreads("import").pipe(withT3Home(t3.home));
      const sql = yield* SqlClient.SqlClient;
      const [copy] = yield* pmThreads;
      // What storage cleanup removes for a deleted thread (storageCleanup.ts cleanCheckpointRefs):
      // its per-thread refs and every ref of its checkpoint scopes.
      const scopes = yield* sql<{ scope_id: string }>`
        SELECT scope_id FROM orchestration_v2_projection_checkpoint_scopes
        WHERE thread_id = ${copy!.thread_id}`;
      assert.strictEqual(scopes.length, 1);
      const prefixes = [
        `refs/t3/checkpoints/${Base64Url.encode(copy!.thread_id)}/turn/`,
        ...(yield* Effect.forEach(scopes, (scope) =>
          checkpointRefForScopeOrdinal({
            scopeId: CheckpointScopeId.make(scope.scope_id),
            ordinalWithinScope: 0,
          }).pipe(Effect.map((ref) => ref.slice(0, -1))),
        )),
      ];
      const owned = (yield* t3.listRefs).filter((ref) =>
        prefixes.some((prefix) => ref.startsWith(prefix)),
      );
      assert.strictEqual(owned.length, 3);
      assert.isTrue(owned.every((ref) => !t3.t3Refs.includes(ref)));
      for (const ref of owned) yield* t3.run(["update-ref", "-d", ref]);
      assert.deepStrictEqual(yield* t3.listRefs, t3.t3Refs);
    }).pipe(Effect.scoped, Effect.provide(layerPmServer)),
  );

  it.live("replace backs up PM3code's database, then swaps its threads for T3 Code's", () =>
    Effect.gen(function* () {
      const t3 = yield* makeT3Home;
      const service = yield* PmT3Import;
      yield* putThread({ id: "pm-own", projectId: "pm-project", title: "PM own", text: "mine" });
      const result = yield* service.importThreads("replace").pipe(withT3Home(t3.home));
      assert.strictEqual(result.before.pmThreads, 1);
      assert.strictEqual(result.removed, 1);
      assert.strictEqual(result.imported, 1);
      assert.deepStrictEqual(
        (yield* pmThreads).map((row) => row.title),
        ["T3 thread"],
      );
      // The backup holds PM3code's thread as it was.
      assert.isNotNull(result.backupPath);
      const backed = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ title: string }>`SELECT title FROM orchestration_v2_projection_threads`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: result.backupPath! })));
      assert.deepStrictEqual(backed, [{ title: "PM own" }]);
    }).pipe(Effect.scoped, Effect.provide(layerPmServer)),
  );

  it.live("refuses a T3 Code database newer than this build and changes nothing", () =>
    Effect.gen(function* () {
      const t3 = yield* makeT3Home;
      const latest = Math.max(...migrationManifest.map(([id]) => id));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${latest + 1}, 'FromTheFuture')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: t3.dbPath })));
      const service = yield* PmT3Import;
      const status = yield* service.status.pipe(withT3Home(t3.home));
      assert.isTrue(status.source?.newer);
      const failure = yield* service
        .importThreads("replace")
        .pipe(withT3Home(t3.home), Effect.flip);
      assert.strictEqual(failure.code, "conflict");
      assert.include(failure.message, "newer");
      assert.strictEqual((yield* pmThreads).length, 0);
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual((yield* sql`SELECT * FROM projection_projects`).length, 0);
    }).pipe(Effect.scoped, Effect.provide(layerPmServer)),
  );
});
