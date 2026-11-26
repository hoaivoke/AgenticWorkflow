// pipelines: per-thread unified harness & live skill/context provenance store.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runPmMigrations } from "../pm/PmMigrations.ts";

export interface ThreadHarnessRow {
  readonly threadId: string;
  readonly roleName: string | null;
  readonly trackedSkills: ReadonlyArray<string>;
  readonly trackedContextFiles: ReadonlyArray<string>;
  readonly deliveredByProviderThread: Readonly<Record<string, number>>;
  readonly revision: number;
  readonly updatedAt: string;
}

const MAX_TRACKED_SKILLS = 16;
const MAX_TRACKED_CONTEXT_FILES = 24;

interface DbRow {
  readonly thread_id: string;
  readonly role_name: string | null;
  readonly tracked_skills_json: string;
  readonly tracked_context_files_json: string;
  readonly delivered_by_provider_thread_json: string;
  readonly revision: number;
  readonly updated_at: string;
}

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const DeliveredMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number));
const decodeStringArrayJson = Schema.decodeUnknownSync(StringArrayJson);
const encodeStringArrayJson = Schema.encodeSync(StringArrayJson);
const decodeDeliveredMapJson = Schema.decodeUnknownSync(DeliveredMapJson);
const encodeDeliveredMapJson = Schema.encodeSync(DeliveredMapJson);

const parseStringArray = (raw: string): ReadonlyArray<string> => {
  try {
    return decodeStringArrayJson(raw).filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
};

const parseDeliveredMap = (raw: string): Record<string, number> => {
  try {
    const parsed = decodeDeliveredMapJson(raw);
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
};

const dedupeBounded = (items: ReadonlyArray<string>, limit: number): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
};

const toRow = (row: DbRow): ThreadHarnessRow => ({
  threadId: row.thread_id,
  roleName: row.role_name,
  trackedSkills: parseStringArray(row.tracked_skills_json),
  trackedContextFiles: parseStringArray(row.tracked_context_files_json),
  deliveredByProviderThread: parseDeliveredMap(row.delivered_by_provider_thread_json),
  revision: row.revision,
  updatedAt: row.updated_at,
});

export interface ThreadHarnessStoreShape {
  readonly get: (threadId: string) => Effect.Effect<ThreadHarnessRow | null>;
  readonly setConfig: (input: {
    readonly threadId: string;
    readonly roleName: string | null;
    readonly trackedSkills?: ReadonlyArray<string> | undefined;
    readonly trackedContextFiles?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ThreadHarnessRow>;
  readonly mergeObserved: (input: {
    readonly threadId: string;
    readonly skills: ReadonlyArray<string>;
    readonly contextFiles: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly row: ThreadHarnessRow; readonly changed: boolean }>;
  readonly markDelivered: (input: {
    readonly threadId: string;
    readonly providerThreadId: string;
    readonly revision: number;
  }) => Effect.Effect<void>;
  readonly remove: (threadId: string) => Effect.Effect<void>;
}

export class ThreadHarnessStore extends Context.Service<
  ThreadHarnessStore,
  ThreadHarnessStoreShape
>()("t3/pipelines/ThreadHarnessStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runPmMigrations().pipe(Effect.ignore);

  const nowIso = Effect.map(DateTime.now, (now) => DateTime.formatIso(now));

  const get: ThreadHarnessStoreShape["get"] = Effect.fn("ThreadHarnessStore.get")(function* (
    threadId: string,
  ) {
    const rows = yield* sql<DbRow>`
      SELECT
        thread_id,
        role_name,
        tracked_skills_json,
        tracked_context_files_json,
        delivered_by_provider_thread_json,
        revision,
        updated_at
      FROM pm_thread_harness
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(Effect.orElseSucceed((): ReadonlyArray<DbRow> => []));
    const row = rows[0];
    return row ? toRow(row) : null;
  });

  const setConfig: ThreadHarnessStoreShape["setConfig"] = Effect.fn("ThreadHarnessStore.setConfig")(
    function* (input) {
      const existing = yield* get(input.threadId);
      const nextRole = input.roleName?.trim() ? input.roleName.trim() : null;
      const nextSkills =
        input.trackedSkills !== undefined
          ? dedupeBounded(input.trackedSkills, MAX_TRACKED_SKILLS)
          : (existing?.trackedSkills ?? []);
      const nextContext =
        input.trackedContextFiles !== undefined
          ? dedupeBounded(input.trackedContextFiles, MAX_TRACKED_CONTEXT_FILES)
          : (existing?.trackedContextFiles ?? []);
      const nextRevision = (existing?.revision ?? 0) + 1;
      const delivered = existing?.deliveredByProviderThread ?? {};
      const updatedAt = yield* nowIso;

      yield* sql`
        INSERT INTO pm_thread_harness (
          thread_id,
          role_name,
          tracked_skills_json,
          tracked_context_files_json,
          delivered_by_provider_thread_json,
          revision,
          updated_at
        ) VALUES (
          ${input.threadId},
          ${nextRole},
          ${encodeStringArrayJson(nextSkills)},
          ${encodeStringArrayJson(nextContext)},
          ${encodeDeliveredMapJson(delivered)},
          ${nextRevision},
          ${updatedAt}
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          role_name = excluded.role_name,
          tracked_skills_json = excluded.tracked_skills_json,
          tracked_context_files_json = excluded.tracked_context_files_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `.pipe(Effect.ignore);

      return {
        threadId: input.threadId,
        roleName: nextRole,
        trackedSkills: nextSkills,
        trackedContextFiles: nextContext,
        deliveredByProviderThread: delivered,
        revision: nextRevision,
        updatedAt,
      };
    },
  );

  const mergeObserved: ThreadHarnessStoreShape["mergeObserved"] = Effect.fn(
    "ThreadHarnessStore.mergeObserved",
  )(function* (input) {
    const existing = yield* get(input.threadId);
    const prevSkills = existing?.trackedSkills ?? [];
    const prevContext = existing?.trackedContextFiles ?? [];
    const nextSkills = dedupeBounded([...prevSkills, ...input.skills], MAX_TRACKED_SKILLS);
    const nextContext = dedupeBounded(
      [...prevContext, ...input.contextFiles],
      MAX_TRACKED_CONTEXT_FILES,
    );
    const changed =
      nextSkills.length !== prevSkills.length || nextContext.length !== prevContext.length;

    if (!changed && existing !== null) {
      return { row: existing, changed: false };
    }
    if (!changed && nextSkills.length === 0 && nextContext.length === 0) {
      const updatedAt = yield* nowIso;
      return {
        row: {
          threadId: input.threadId,
          roleName: null,
          trackedSkills: [],
          trackedContextFiles: [],
          deliveredByProviderThread: {},
          revision: 0,
          updatedAt,
        },
        changed: false,
      };
    }

    const nextRevision = (existing?.revision ?? 0) + 1;
    const delivered = existing?.deliveredByProviderThread ?? {};
    const updatedAt = yield* nowIso;

    yield* sql`
      INSERT INTO pm_thread_harness (
        thread_id,
        role_name,
        tracked_skills_json,
        tracked_context_files_json,
        delivered_by_provider_thread_json,
        revision,
        updated_at
      ) VALUES (
        ${input.threadId},
        ${existing?.roleName ?? null},
        ${encodeStringArrayJson(nextSkills)},
        ${encodeStringArrayJson(nextContext)},
        ${encodeDeliveredMapJson(delivered)},
        ${nextRevision},
        ${updatedAt}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        tracked_skills_json = excluded.tracked_skills_json,
        tracked_context_files_json = excluded.tracked_context_files_json,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `.pipe(Effect.ignore);

    return {
      row: {
        threadId: input.threadId,
        roleName: existing?.roleName ?? null,
        trackedSkills: nextSkills,
        trackedContextFiles: nextContext,
        deliveredByProviderThread: delivered,
        revision: nextRevision,
        updatedAt,
      },
      changed: true,
    };
  });

  const markDelivered: ThreadHarnessStoreShape["markDelivered"] = Effect.fn(
    "ThreadHarnessStore.markDelivered",
  )(function* (input) {
    const existing = yield* get(input.threadId);
    if (existing === null) return;
    const nextDelivered = {
      ...existing.deliveredByProviderThread,
      [input.providerThreadId]: input.revision,
    };
    const updatedAt = yield* nowIso;
    yield* sql`
      UPDATE pm_thread_harness
      SET
        delivered_by_provider_thread_json = ${encodeDeliveredMapJson(nextDelivered)},
        updated_at = ${updatedAt}
      WHERE thread_id = ${input.threadId}
    `.pipe(Effect.ignore);
  });

  const remove: ThreadHarnessStoreShape["remove"] = Effect.fn("ThreadHarnessStore.remove")(
    function* (threadId: string) {
      yield* sql`DELETE FROM pm_thread_harness WHERE thread_id = ${threadId}`.pipe(Effect.ignore);
    },
  );

  return { get, setConfig, mergeObserved, markDelivered, remove } satisfies ThreadHarnessStoreShape;
});

export const layer = Layer.effect(ThreadHarnessStore, make);
