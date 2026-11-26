import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// The fork keeps its own ledger so upstream's `effect_sql_migrations` never sees a fork id: an
// upstream build opens a fork database unchanged, and the fork opens an upstream one by adding
// these tables. Only `CREATE ... IF NOT EXISTS pm_*`; never touch an upstream table, and no
// foreign keys into upstream tables (upstream rebuilds them).
export const PM_MIGRATIONS_TABLE = "pm_migrations";

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      mission TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      next_item_no INTEGER NOT NULL DEFAULT 1,
      next_ask_no INTEGER NOT NULL DEFAULT 1,
      next_link_no INTEGER NOT NULL DEFAULT 1,
      guide_version_read INTEGER,
      guide_text_read TEXT,
      open_asks_told TEXT NOT NULL DEFAULT '',
      turn_run_id TEXT,
      turn_started_at TEXT,
      previous_turn_started_at TEXT,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_threads_project ON pm_threads (project_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_workers (
      worker_thread_id TEXT PRIMARY KEY,
      pm_thread_id TEXT NOT NULL,
      item_no INTEGER,
      linked_at TEXT NOT NULL,
      resolved_at TEXT,
      last_report_kind TEXT,
      last_report_at TEXT,
      last_report_line TEXT,
      watch_json TEXT NOT NULL DEFAULT '{}'
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_workers_pm ON pm_workers (pm_thread_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_items (
      pm_thread_id TEXT NOT NULL,
      item_no INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      later_reason TEXT,
      now_line TEXT,
      done_line TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      dropped_at TEXT,
      PRIMARY KEY (pm_thread_id, item_no)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_item_steps (
      pm_thread_id TEXT NOT NULL,
      item_no INTEGER NOT NULL,
      step_no INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      chore INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL,
      PRIMARY KEY (pm_thread_id, item_no, step_no)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_item_waits (
      pm_thread_id TEXT NOT NULL,
      item_no INTEGER NOT NULL,
      wait_no INTEGER NOT NULL,
      on_kind TEXT NOT NULL,
      on_ref TEXT NOT NULL,
      since TEXT NOT NULL,
      cleared_at TEXT,
      PRIMARY KEY (pm_thread_id, item_no, wait_no)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_asks (
      pm_thread_id TEXT NOT NULL,
      ask_no INTEGER NOT NULL,
      item_no INTEGER,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      answers_json TEXT NOT NULL DEFAULT '[]',
      recommended TEXT,
      holds INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      answer TEXT,
      snoozed_until TEXT,
      dismissal_told INTEGER NOT NULL DEFAULT 0,
      answer_message_id TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT,
      PRIMARY KEY (pm_thread_id, ask_no)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_links (
      pm_thread_id TEXT NOT NULL,
      link_no INTEGER NOT NULL,
      item_no INTEGER,
      worker_thread_id TEXT,
      url TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      PRIMARY KEY (pm_thread_id, link_no)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_memory (
      pm_thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pm_thread_id, position)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_reports (
      report_id TEXT PRIMARY KEY,
      pm_thread_id TEXT NOT NULL,
      worker_thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      line TEXT NOT NULL,
      text TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (worker_thread_id, kind, dedupe_key)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_reports_pm ON pm_reports (pm_thread_id, created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_pages (
      page_id TEXT PRIMARY KEY,
      pm_thread_id TEXT NOT NULL,
      item_no INTEGER,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      question_tags_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL,
      answers_json TEXT,
      message_id TEXT,
      answers_message_id TEXT,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_pages_pm ON pm_pages (pm_thread_id, created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});

// The Inbox: a page's opened, snoozed and settled times, and a finished item archived from Done.
const addInboxColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pm_pages ADD COLUMN opened_at TEXT`;
  yield* sql`ALTER TABLE pm_pages ADD COLUMN snoozed_until TEXT`;
  yield* sql`ALTER TABLE pm_pages ADD COLUMN settled_at TEXT`;
  yield* sql`ALTER TABLE pm_items ADD COLUMN archived_at TEXT`;
});

const createImportAndRetiredTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Threads copied from T3 Code under new ids; the source id keeps a second import from doubling.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_t3_imported_threads (
      thread_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      imported_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_t3_imported_source ON pm_t3_imported_threads (source_thread_id)`;
  // A PM turned back into a normal thread keeps its row here, so making it a PM again restores it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_retired_threads (
      pm_thread_id TEXT PRIMARY KEY,
      row_json TEXT NOT NULL,
      retired_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});

// Ghostex 6d04b0ffe: a worker's latest push note, sent with pm_worker_note.
const addWorkerNoteColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pm_workers ADD COLUMN last_note TEXT`;
  yield* sql`ALTER TABLE pm_workers ADD COLUMN last_note_at TEXT`;
});

// A worker on another computer the user linked: null on both means this computer.
const addWorkerComputerColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pm_workers ADD COLUMN environment_id TEXT`;
  yield* sql`ALTER TABLE pm_workers ADD COLUMN environment_label TEXT`;
});

const createSwarmTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_swarms (
      swarm_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      coordinator_thread_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_swarms_coordinator ON pm_swarms (coordinator_thread_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_swarm_channels (
      swarm_id TEXT NOT NULL,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (swarm_id, name)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_swarm_members (
      swarm_id TEXT NOT NULL,
      name TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      role TEXT,
      workspace_mode TEXT NOT NULL DEFAULT 'inherit',
      channels_json TEXT NOT NULL DEFAULT '["main"]',
      primary_channel TEXT NOT NULL DEFAULT 'main',
      added_by TEXT NOT NULL DEFAULT 'coordinator',
      state TEXT NOT NULL DEFAULT 'working',
      wait_since_seq INTEGER NOT NULL DEFAULT 0,
      mentions_only INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (swarm_id, name)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS pm_swarm_members_thread ON pm_swarm_members (thread_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_swarm_posts (
      swarm_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'main',
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY (swarm_id, seq)
    ) WITHOUT ROWID
  `;
});

const createThreadHarnessTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_thread_harness (
      thread_id TEXT PRIMARY KEY,
      role_name TEXT,
      tracked_skills_json TEXT NOT NULL DEFAULT '[]',
      tracked_context_files_json TEXT NOT NULL DEFAULT '[]',
      delivered_by_provider_thread_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});

const pmMigrationEntries = [
  [1, "PmTables", createTables],
  [2, "PmInbox", addInboxColumns],
  [3, "PmImportAndRetired", createImportAndRetiredTables],
  [4, "PmWorkerNotes", addWorkerNoteColumns],
  [5, "PmWorkerComputers", addWorkerComputerColumns],
  // pipelines: high id keeps fork migrations out of upstream's sequential pm_migrations ids.
  [100, "PmSwarm", createSwarmTables],
  [101, "PmThreadHarness", createThreadHarnessTable],
] as const;

const run = Migrator.make({});

export const runPmMigrations = Effect.fn("PmMigrations.run")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // pipelines: earlier fork builds recorded PmSwarm at id 4 before upstream added 4/5; clear
  // that old ledger row so upstream 4/5 run cleanly and PmSwarm re-records idempotently at 100.
  yield* sql`DELETE FROM pm_migrations WHERE migration_id = 4 AND name = 'PmSwarm'`.pipe(
    Effect.ignore,
  );
  return yield* run({
    table: PM_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        pmMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
