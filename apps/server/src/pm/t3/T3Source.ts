import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// t3code-pm: PM3code reads official T3 Code's data and never writes it. Every read goes through a
// copy taken in one read-only transaction (`ATTACH ... ?mode=ro`), as `migrate-dev-db` takes its
// snapshot, so a running T3 Code keeps writing undisturbed.

/** Points PM3code at another T3 Code home; tests and dev runs use a copy, never `~/.t3`. */
export const T3_HOME_ENV = "T3CODE_PM_T3_HOME";

export interface T3Source {
  readonly home: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly settingsPath: string;
  readonly clientSettingsPath: string;
}

/** T3 Code's home, or null when it is missing or is PM3code's own home. */
export const resolveT3Source = Effect.fn("PmT3.resolveSource")(function* (pmBaseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const configured = env[T3_HOME_ENV]?.trim();
  const home = path.resolve(
    configured !== undefined && configured.length > 0
      ? configured
      : path.join(yield* HostProcess.HomeDirectory, ".t3"),
  );
  const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
  if ((yield* real(home)) === (yield* real(pmBaseDir))) return null;
  const stateDir = path.join(home, "userdata");
  if (!(yield* fs.exists(stateDir).pipe(Effect.orElseSucceed(() => false)))) return null;
  return {
    home,
    stateDir,
    dbPath: path.join(stateDir, "statev2.sqlite"),
    settingsPath: path.join(stateDir, "settings.json"),
    clientSettingsPath: path.join(stateDir, "client-settings.json"),
  } satisfies T3Source;
});

const removeDatabaseFiles = Effect.fn("PmT3.removeDatabaseFiles")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    yield* fs.remove(`${databasePath}${suffix}`, { force: true }).pipe(Effect.ignore);
  }
});

const readOnlyUrl = (databasePath: string) => `${NodeURL.pathToFileURL(databasePath).href}?mode=ro`;

/**
 * Copies T3 Code's whole database into `snapshotPath` in one read transaction. `VACUUM ... INTO`
 * copies pages, so full-text indexes come over intact; the source file is only read.
 */
export const snapshotDatabase = Effect.fn("PmT3.snapshotDatabase")(function* (
  sourcePath: string,
  snapshotPath: string,
) {
  const scratch = `${snapshotPath}.attach`;
  yield* removeDatabaseFiles(snapshotPath);
  yield* removeDatabaseFiles(scratch);
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ${readOnlyUrl(sourcePath)} AS src`;
    yield* sql`VACUUM src INTO ${snapshotPath}`;
    yield* sql`DETACH DATABASE src`;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: scratch })),
    Effect.ensuring(removeDatabaseFiles(scratch)),
  );
});

/** Copies a few tables into a scratch file in one read transaction and reads them from there. */
export const readTables = Effect.fn("PmT3.readTables")(function* <
  const Tables extends ReadonlyArray<string>,
>(sourcePath: string, scratchPath: string, tables: Tables) {
  yield* removeDatabaseFiles(scratchPath);
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ${readOnlyUrl(sourcePath)} AS src`;
    const present = yield* sql.withTransaction(
      Effect.gen(function* () {
        const found = new Set(
          (yield* sql<{ name: string }>`
            SELECT name FROM src.sqlite_master WHERE type = 'table'`).map((row) => row.name),
        );
        for (const table of tables) {
          if (!found.has(table)) continue;
          yield* sql.unsafe(`CREATE TABLE main."${table}" AS SELECT * FROM src."${table}"`)
            .unprepared;
        }
        return found;
      }),
    );
    yield* sql`DETACH DATABASE src`;
    const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
    for (const table of tables) {
      result[table] = present.has(table)
        ? yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM main."${table}"`)
        : [];
    }
    return result as { readonly [K in Tables[number]]: ReadonlyArray<Record<string, unknown>> };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: scratchPath })),
    Effect.ensuring(removeDatabaseFiles(scratchPath)),
  );
});

const decodeJson = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));

/** A JSON file's value, or undefined when it is missing or unreadable. */
export const readJsonFile = (filePath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(filePath)),
    Effect.flatMap(decodeJson),
    Effect.orElseSucceed((): unknown => undefined),
  );
