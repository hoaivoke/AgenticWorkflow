import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PM_MIGRATIONS_TABLE, runPmMigrations } from "./PmMigrations.ts";
import * as PmStore from "./PmStore.ts";

const upstreamHead = Math.max(...migrationManifest.map(([id]) => id));

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const upstreamLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
});

describe("PM migrations", () => {
  it.effect(
    "the fork opens an upstream database by adding only pm_* tables and its own ledger",
    () =>
      Effect.gen(function* () {
        const before = yield* tableNames;
        const ledgerBefore = yield* upstreamLedger;
        yield* Effect.provide(Effect.void, PmStore.layer);
        const after = yield* tableNames;
        const added = after.filter((name) => !before.includes(name));
        assert.deepStrictEqual(
          added.toSorted(),
          [
            PM_MIGRATIONS_TABLE,
            "pm_asks",
            "pm_item_steps",
            "pm_item_waits",
            "pm_items",
            "pm_links",
            "pm_memory",
            "pm_pages",
            "pm_reports",
            "pm_retired_threads",
            "pm_settings",
            "pm_t3_imported_threads",
            "pm_threads",
            "pm_workers",
          ].toSorted(),
        );
        // Upstream's ledger is untouched, so no fork id can collide with a later upstream one.
        assert.deepStrictEqual(yield* upstreamLedger, ledgerBefore);
        assert.strictEqual(ledgerBefore.at(-1)?.migration_id, upstreamHead);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("upstream's migrator opens a fork database and its PM ledger reruns as a no-op", () =>
    Effect.gen(function* () {
      yield* Effect.provide(Effect.void, PmStore.layer);
      // Upstream's own startup path: validates history and runs nothing new.
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, []);
      assert.deepStrictEqual(yield* runPmMigrations(), []);
      const sql = yield* SqlClient.SqlClient;
      const pmLedger = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM pm_migrations
      `;
      assert.deepStrictEqual(
        pmLedger.map((row) => row.migration_id),
        [1, 2, 3, 4],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a 0.2.1 database and an Inbox database each run only the migrations they lack", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runPmMigrations();
      // Back to 0.2.1: only PmTables ran.
      yield* sql`DROP TABLE pm_t3_imported_threads`;
      yield* sql`DROP TABLE pm_retired_threads`;
      for (const [table, column] of [
        ["pm_pages", "opened_at"],
        ["pm_pages", "snoozed_until"],
        ["pm_pages", "settled_at"],
        ["pm_items", "archived_at"],
        ["pm_workers", "last_note"],
        ["pm_workers", "last_note_at"],
      ])
        yield* sql.unsafe(`ALTER TABLE ${table} DROP COLUMN ${column}`).unprepared;
      yield* sql`DELETE FROM pm_migrations WHERE migration_id > 1`;
      const from021 = yield* runPmMigrations();
      assert.deepStrictEqual(
        from021.map(([id, name]) => `${id}_${name}`),
        ["2_PmInbox", "3_PmImportAndRetired", "4_PmWorkerNotes"],
      );
      const [archived] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM pragma_table_info('pm_items') WHERE name = 'archived_at'`;
      assert.strictEqual(archived?.count, 1);

      // An Inbox build already ran 2; only the new tables come.
      yield* sql`DROP TABLE pm_t3_imported_threads`;
      yield* sql`DROP TABLE pm_retired_threads`;
      yield* sql`ALTER TABLE pm_workers DROP COLUMN last_note`;
      yield* sql`ALTER TABLE pm_workers DROP COLUMN last_note_at`;
      yield* sql`DELETE FROM pm_migrations WHERE migration_id > 2`;
      const fromInbox = yield* runPmMigrations();
      assert.deepStrictEqual(
        fromInbox.map(([id]) => id),
        [3, 4],
      );
      assert.includeMembers(yield* tableNames, ["pm_retired_threads", "pm_t3_imported_threads"]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("PmStore", () => {
  it.effect("counters only go up, across withdraws and a restart", () =>
    Effect.gen(function* () {
      const first = yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* PmStore.PmStore;
          yield* store.insertPm({ threadId: "pm-1", projectId: "p", createdAt: "2026-01-01" });
          const a = yield* store.allocate("pm-1", "next_ask_no");
          const b = yield* store.allocate("pm-1", "next_ask_no");
          return [a, b];
        }),
        PmStore.layer,
      );
      assert.deepStrictEqual(first, [1, 2]);
      // A second layer over the same database is a server restart.
      const afterRestart = yield* Effect.provide(
        Effect.flatMap(PmStore.PmStore, (store) => store.allocate("pm-1", "next_ask_no")),
        PmStore.layer,
      );
      assert.strictEqual(afterRestart, 3);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a report is claimed once; a second claim returns the stored row", () =>
    Effect.gen(function* () {
      const store = yield* PmStore.PmStore;
      const claim = (line: string) =>
        store.claimReport({
          reportId: "report:w:finished:run:1",
          pmThreadId: "pm-1",
          workerThreadId: "w",
          kind: "finished",
          dedupeKey: "run:1",
          messageId: "message:1",
          line,
          text: line,
          summary: line,
          createdAt: "2026-01-01",
        });
      const first = yield* claim("first");
      yield* store.markReportDelivered("report:w:finished:run:1", "2026-01-02");
      const second = yield* claim("second");
      assert.strictEqual(first?.deliveredAt, null);
      assert.strictEqual(second?.line, "first");
      assert.strictEqual(second?.deliveredAt, "2026-01-02");
      assert.strictEqual((yield* store.listUndeliveredReports()).length, 0);
    }).pipe(Effect.provide(PmStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
  );

  it.effect("deleting a PM removes its rows and unlinks its workers", () =>
    Effect.gen(function* () {
      const store = yield* PmStore.PmStore;
      yield* store.insertPm({ threadId: "pm-1", projectId: "p", createdAt: "2026-01-01" });
      yield* store.insertItem("pm-1", { itemNo: 1, title: "Work", at: "2026-01-01" });
      yield* store.upsertWorker({
        workerThreadId: "w",
        pmThreadId: "pm-1",
        itemNo: 1,
        linkedAt: "2026-01-01",
      });
      yield* store.deletePm("pm-1");
      assert.strictEqual(yield* store.getPm("pm-1"), null);
      assert.deepStrictEqual(yield* store.listItems("pm-1"), []);
      assert.strictEqual(yield* store.getWorker("w"), null);
    }).pipe(Effect.provide(PmStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
  );
});
