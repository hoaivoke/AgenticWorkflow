import {
  ClientSettingsSchema,
  CommandId,
  isSecretReference,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ServerSettings,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ServerConfig from "../../config.ts";
import { scratchFolderRoot } from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { mergeFollowedSettings, type SettingsBaseline } from "./settingsMerge.ts";
import { readJsonFile, readTables, resolveT3Source } from "./T3Source.ts";

// t3code-pm: on each launch PM3code takes T3 Code's new projects and the settings the person has
// not changed in PM3code. State lives in one small file beside settings.json, so the settings
// part runs before the database or the settings service opens.

export const SYNC_STATE_FILE = "pm-t3-sync.json";

const SyncState = Schema.Struct({
  enabled: Schema.Boolean,
  serverSettings: Schema.Record(Schema.String, Schema.Unknown),
  clientSettings: Schema.Record(Schema.String, Schema.Unknown),
  /** Folders of T3 Code projects already offered; one deleted in PM3code stays deleted. */
  projectsSeen: Schema.Array(Schema.String),
  lastLaunch: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      projectsAdded: Schema.Number,
      settingsChanged: Schema.Number,
      skipped: Schema.NullOr(Schema.String),
    }),
  ),
});
export type SyncState = typeof SyncState.Type;

const EMPTY_STATE: SyncState = {
  enabled: true,
  serverSettings: {},
  clientSettings: {},
  projectsSeen: [],
  lastLaunch: null,
};

type ConfigPaths = Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "stateDir">;

const decodeState = Schema.decodeUnknownEffect(SyncState);
const encodePretty = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeClientSettings = Schema.decodeUnknownEffect(ClientSettingsSchema);
const SERVER_DEFAULTS = Schema.encodeSync(ServerSettings)(Schema.decodeSync(ServerSettings)({}));
const CLIENT_DEFAULTS = Schema.encodeSync(ClientSettingsSchema)(
  Schema.decodeSync(ClientSettingsSchema)({}),
);

const statePath = (stateDir: string) =>
  Effect.map(Path.Path, (path) => path.join(stateDir, SYNC_STATE_FILE));

const writeJson = (filePath: string, value: unknown) =>
  encodePretty(value).pipe(
    Effect.flatMap((contents) =>
      writeFileStringAtomically({ filePath, contents: `${contents}\n` }),
    ),
  );

export const readSyncState = Effect.fn("PmT3Sync.readState")(function* (stateDir: string) {
  const value = yield* readJsonFile(yield* statePath(stateDir));
  if (typeof value !== "object" || value === null) return EMPTY_STATE;
  return yield* decodeState({ ...EMPTY_STATE, ...value }).pipe(
    Effect.orElseSucceed(() => EMPTY_STATE),
  );
});

const updateSyncState = Effect.fn("PmT3Sync.updateState")(function* (
  stateDir: string,
  update: (state: SyncState) => SyncState,
) {
  const next = update(yield* readSyncState(stateDir));
  yield* writeJson(yield* statePath(stateDir), next);
  return next;
});

export const setSyncEnabled = (stateDir: string, enabled: boolean) =>
  updateSyncState(stateDir, (state) => ({ ...state, enabled }));

/** Merges one settings file and writes it only when it changed and still decodes. */
const mergeFile = Effect.fn("PmT3Sync.mergeFile")(function* (input: {
  readonly t3Path: string;
  readonly pmPath: string;
  readonly defaults: unknown;
  readonly baseline: SettingsBaseline;
  readonly validate: (value: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}) {
  const unchanged = { baseline: input.baseline, changed: 0 };
  const t3 = yield* readJsonFile(input.t3Path);
  if (t3 === undefined) return unchanged;
  // T3 Code may be newer or older: a file this build cannot read is left alone.
  if (Option.isNone(yield* Effect.option(input.validate(t3)))) return unchanged;
  const merged = mergeFollowedSettings({
    pm: (yield* readJsonFile(input.pmPath)) ?? {},
    t3,
    defaults: input.defaults,
    baseline: input.baseline,
    // A secret reference names a secret only T3 Code's store holds.
    skip: (value) => isSecretReference(value),
  });
  if (merged.changed > 0) {
    if (Option.isNone(yield* Effect.option(input.validate(merged.next)))) return unchanged;
    yield* writeJson(input.pmPath, merged.next);
  }
  return { baseline: merged.baseline, changed: merged.changed };
});

/**
 * Runs before the server opens its database and settings, so the desktop window and the settings
 * service read the merged files. Never fails the launch.
 */
export const syncSettingsAtLaunch = Effect.fn("PmT3Sync.settingsAtLaunch")(
  function* (config: ConfigPaths) {
    const path = yield* Path.Path;
    const state = yield* readSyncState(config.stateDir);
    if (!state.enabled) return;
    const at = DateTime.formatIso(yield* DateTime.now);
    const source = yield* resolveT3Source(config.baseDir);
    if (source === null) {
      yield* updateSyncState(config.stateDir, (current) => ({
        ...current,
        lastLaunch: { at, projectsAdded: 0, settingsChanged: 0, skipped: "missing" },
      }));
      return;
    }
    const server = yield* mergeFile({
      t3Path: source.settingsPath,
      pmPath: path.join(config.stateDir, "settings.json"),
      defaults: SERVER_DEFAULTS,
      baseline: state.serverSettings,
      validate: decodeServerSettings,
    });
    const client = yield* mergeFile({
      t3Path: source.clientSettingsPath,
      pmPath: path.join(config.stateDir, "client-settings.json"),
      defaults: CLIENT_DEFAULTS,
      baseline: state.clientSettings,
      validate: decodeClientSettings,
    });
    yield* updateSyncState(config.stateDir, (current) => ({
      ...current,
      serverSettings: server.baseline,
      clientSettings: client.baseline,
      lastLaunch: {
        at,
        projectsAdded: 0,
        settingsChanged: server.changed + client.changed,
        skipped: null,
      },
    }));
  },
  Effect.timeout("3 seconds"),
  Effect.catchCause((cause) => Effect.logWarning("Skipped reading T3 Code's settings", { cause })),
);

const decodeScripts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

/** T3 Code's No project folder, as written and as resolved through a symlink. */
export const t3ScratchRoots = Effect.fn("PmT3Sync.t3ScratchRoots")(function* (t3Home: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = scratchFolderRoot(t3Home, path);
  return new Set([root, yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root))]);
});

/** PM3code's own No project, created on first use; none when this home cannot have one. */
export type PmNoProject = Effect.Effect<Option.Option<string>>;

/**
 * Adds T3 Code's projects whose folder PM3code has no project for, keeping T3 Code's id when it is
 * free so its threads and per-project settings line up. Returns T3 project id → PM3code id.
 */
export const syncProjects = Effect.fn("PmT3Sync.projects")(function* (input: {
  readonly config: ConfigPaths;
  readonly dbPath: string;
  readonly t3Home: string;
  readonly pmNoProject: PmNoProject;
  /** The launch read skips folders it offered before; an import adds every project it needs. */
  readonly respectSeen: boolean;
}) {
  const path = yield* Path.Path;
  const t3Scratch = yield* t3ScratchRoots(input.t3Home);
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const scratch = path.join(input.config.stateDir, `pm-t3-projects-${yield* randomUuidV4}.sqlite`);
  const tables = yield* readTables(input.dbPath, scratch, ["projection_projects"]);
  const t3Projects = tables.projection_projects.filter((row) => !text(row.deleted_at));
  const pmRows = yield* sql<{
    project_id: string;
    workspace_root: string;
    deleted_at: string | null;
  }>`SELECT project_id, workspace_root, deleted_at FROM projection_projects`;
  const pmByRoot = new Map(
    pmRows
      .filter((row) => row.deleted_at === null)
      .map((row) => [path.resolve(row.workspace_root), row.project_id]),
  );
  const takenIds = new Set(pmRows.map((row) => row.project_id));
  const seen = new Set((yield* readSyncState(input.config.stateDir)).projectsSeen);
  const idMap = new Map<string, string>();
  let added = 0;
  for (const row of t3Projects) {
    const t3Id = String(row.project_id);
    const root = path.resolve(String(row.workspace_root));
    // T3 Code's No project is PM3code's own No project, never an ordinary project at T3's folder.
    if (t3Scratch.has(root)) {
      const noProject = yield* input.pmNoProject;
      if (Option.isSome(noProject)) idMap.set(t3Id, noProject.value);
      continue;
    }
    const existing = pmByRoot.get(root);
    if (existing !== undefined) {
      idMap.set(t3Id, existing);
      seen.add(root);
      continue;
    }
    // Archived projects come over only with an import that needs them for their threads.
    if (input.respectSeen && (seen.has(root) || text(row.archived_at) !== null)) continue;
    const projectId = ProjectId.make(takenIds.has(t3Id) ? yield* randomUuidV4 : t3Id);
    const scriptsJson = text(row.scripts_json);
    const scripts =
      scriptsJson === null
        ? undefined
        : yield* decodeScripts(scriptsJson).pipe(Effect.orElseSucceed(() => undefined));
    const created = yield* projects
      .create({
        commandId: CommandId.make(`command:pm-t3-project:${yield* randomUuidV4}`),
        projectId,
        title: String(row.title),
        workspaceRoot: root,
        ...(scripts === undefined ? {} : { scripts }),
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not add a T3 Code project", { root, cause }),
        ),
        Effect.option,
      );
    seen.add(root);
    if (Option.isNone(created)) continue;
    added += 1;
    takenIds.add(projectId);
    pmByRoot.set(root, projectId);
    idMap.set(t3Id, projectId);
    const modelJson = text(row.default_model_selection_json);
    const model =
      modelJson === null ? Option.none() : yield* Effect.option(decodeModelSelection(modelJson));
    const archived = text(row.archived_at) !== null;
    if (Option.isSome(model) || archived) {
      yield* projects
        .update({
          commandId: CommandId.make(`command:pm-t3-project-update:${yield* randomUuidV4}`),
          projectId,
          ...(Option.isSome(model) ? { defaultModelSelection: model.value } : {}),
          ...(archived ? { archived: true } : {}),
        })
        .pipe(Effect.ignore);
    }
  }
  yield* updateSyncState(input.config.stateDir, (current) => ({
    ...current,
    projectsSeen: [...seen].sort(),
  }));
  return { added, idMap };
});

/** The launch half that needs the running server: new projects. Never fails the server. */
export const syncProjectsAtLaunch = Effect.fn("PmT3Sync.projectsAtLaunch")(
  function* (config: ConfigPaths, pmNoProject: PmNoProject) {
    const state = yield* readSyncState(config.stateDir);
    if (!state.enabled) return;
    const source = yield* resolveT3Source(config.baseDir);
    if (source === null) return;
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(source.dbPath))) return;
    const { added } = yield* syncProjects({
      config,
      dbPath: source.dbPath,
      t3Home: source.home,
      pmNoProject,
      respectSeen: true,
    });
    yield* updateSyncState(config.stateDir, (current) => ({
      ...current,
      lastLaunch:
        current.lastLaunch === null ? null : { ...current.lastLaunch, projectsAdded: added },
    }));
  },
  Effect.catchCause((cause) => Effect.logWarning("Skipped reading T3 Code's projects", { cause })),
);
