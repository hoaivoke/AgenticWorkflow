import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { PmError } from "@t3tools/contracts";

import { runPmMigrations } from "../pm/PmMigrations.ts";

export type SwarmMemberState = "working" | "waiting" | "stopped" | "killed";
export type SwarmWorkspaceMode = "inherit" | "worktree";

export interface SwarmRow {
  readonly swarmId: string;
  readonly projectId: string;
  readonly coordinatorThreadId: string;
  readonly title: string;
  readonly status: "active" | "done";
  readonly nextSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SwarmChannelRow {
  readonly swarmId: string;
  readonly name: string;
  readonly topic: string;
  readonly archived: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface SwarmMemberRow {
  readonly swarmId: string;
  readonly name: string;
  readonly threadId: string;
  readonly role: string | null;
  readonly workspaceMode: SwarmWorkspaceMode;
  readonly channels: ReadonlyArray<string>;
  readonly primaryChannel: string;
  readonly addedBy: string;
  readonly state: SwarmMemberState;
  readonly waitSinceSeq: number;
  readonly mentionsOnly: boolean;
  readonly createdAt: string;
}

export interface SwarmPostRow {
  readonly swarmId: string;
  readonly seq: number;
  readonly channel: string;
  readonly sender: string;
  readonly text: string;
  readonly mentions: ReadonlyArray<string>;
  readonly createdAt: string;
}

type Row = Record<string, unknown>;
const parseJson = <A>(value: unknown, fallback: A): A => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

const toSwarmRow = (row: Row): SwarmRow => ({
  swarmId: String(row.swarm_id),
  projectId: String(row.project_id),
  coordinatorThreadId: String(row.coordinator_thread_id),
  title: String(row.title ?? ""),
  status: row.status === "done" ? "done" : "active",
  nextSeq: Number(row.next_seq ?? 1),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const toChannelRow = (row: Row): SwarmChannelRow => ({
  swarmId: String(row.swarm_id),
  name: String(row.name),
  topic: String(row.topic ?? ""),
  archived: Number(row.archived ?? 0) !== 0,
  createdBy: String(row.created_by ?? "coordinator"),
  createdAt: String(row.created_at),
});

const toMemberRow = (row: Row): SwarmMemberRow => ({
  swarmId: String(row.swarm_id),
  name: String(row.name),
  threadId: String(row.thread_id),
  role: row.role === null || row.role === undefined ? null : String(row.role),
  workspaceMode: row.workspace_mode === "worktree" ? "worktree" : "inherit",
  channels: parseJson<Array<string>>(row.channels_json, ["main"]),
  primaryChannel: String(row.primary_channel ?? "main"),
  addedBy: String(row.added_by ?? "coordinator"),
  state: (["working", "waiting", "stopped", "killed"].includes(String(row.state))
    ? String(row.state)
    : "waiting") as SwarmMemberState,
  waitSinceSeq: Number(row.wait_since_seq ?? 0),
  mentionsOnly: Number(row.mentions_only ?? 1) !== 0,
  createdAt: String(row.created_at),
});

const toPostRow = (row: Row): SwarmPostRow => ({
  swarmId: String(row.swarm_id),
  seq: Number(row.seq),
  channel: String(row.channel ?? "main"),
  sender: String(row.sender),
  text: String(row.text),
  mentions: parseJson<Array<string>>(row.mentions_json, []),
  createdAt: String(row.created_at),
});

const wrapSql = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new PmError({
          code: "unavailable",
          message: `Swarm storage failed: ${cause.message}`,
        }),
    ),
  );

export class SwarmStore extends Context.Service<
  SwarmStore,
  {
    readonly getSwarm: (swarmId: string) => Effect.Effect<SwarmRow | null, PmError>;
    readonly listActiveSwarms: () => Effect.Effect<ReadonlyArray<SwarmRow>, PmError>;
    readonly findSwarmByCoordinator: (threadId: string) => Effect.Effect<SwarmRow | null, PmError>;
    readonly getMemberByThread: (threadId: string) => Effect.Effect<SwarmMemberRow | null, PmError>;
    readonly findSwarmForThread: (threadId: string) => Effect.Effect<
      {
        readonly swarm: SwarmRow;
        readonly memberName: string;
        readonly member: SwarmMemberRow | null;
      } | null,
      PmError
    >;
    readonly createSwarm: (input: {
      readonly swarmId: string;
      readonly projectId: string;
      readonly coordinatorThreadId: string;
      readonly title: string;
      readonly at: string;
    }) => Effect.Effect<SwarmRow, PmError>;
    readonly setSwarmTitle: (
      swarmId: string,
      title: string,
      at: string,
    ) => Effect.Effect<void, PmError>;
    readonly setSwarmStatus: (
      swarmId: string,
      status: "active" | "done",
      at: string,
    ) => Effect.Effect<void, PmError>;
    readonly listMembers: (
      swarmId: string,
    ) => Effect.Effect<ReadonlyArray<SwarmMemberRow>, PmError>;
    readonly getMember: (
      swarmId: string,
      name: string,
    ) => Effect.Effect<SwarmMemberRow | null, PmError>;
    readonly insertMember: (member: SwarmMemberRow) => Effect.Effect<void, PmError>;
    readonly updateMemberState: (input: {
      readonly swarmId: string;
      readonly name: string;
      readonly state: SwarmMemberState;
      readonly waitSinceSeq?: number | undefined;
      readonly mentionsOnly?: boolean | undefined;
    }) => Effect.Effect<void, PmError>;
    readonly updateMemberChannels: (input: {
      readonly swarmId: string;
      readonly name: string;
      readonly channels: ReadonlyArray<string>;
      readonly primaryChannel?: string | undefined;
    }) => Effect.Effect<void, PmError>;
    readonly listChannels: (
      swarmId: string,
    ) => Effect.Effect<ReadonlyArray<SwarmChannelRow>, PmError>;
    readonly upsertChannel: (channel: SwarmChannelRow) => Effect.Effect<void, PmError>;
    readonly archiveChannel: (swarmId: string, name: string) => Effect.Effect<void, PmError>;
    readonly appendPost: (input: {
      readonly swarmId: string;
      readonly channel: string;
      readonly sender: string;
      readonly text: string;
      readonly mentions: ReadonlyArray<string>;
      readonly at: string;
    }) => Effect.Effect<SwarmPostRow, PmError>;
    readonly listPosts: (input: {
      readonly swarmId: string;
      readonly since: number;
      readonly channel?: string | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<ReadonlyArray<SwarmPostRow>, PmError>;
  }
>()("t3/swarm/SwarmStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runPmMigrations();

  const getSwarm = (swarmId: string) =>
    wrapSql(
      sql`SELECT * FROM pm_swarms WHERE swarm_id = ${swarmId} LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] ? toSwarmRow(rows[0] as Row) : null)),
      ),
    );

  const listActiveSwarms = () =>
    wrapSql(
      sql`SELECT * FROM pm_swarms WHERE status = 'active' ORDER BY updated_at DESC`.pipe(
        Effect.map((rows) => rows.map((row) => toSwarmRow(row as Row))),
      ),
    );

  const findSwarmByCoordinator = (threadId: string) =>
    wrapSql(
      sql`SELECT * FROM pm_swarms WHERE coordinator_thread_id = ${threadId} ORDER BY created_at DESC LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] ? toSwarmRow(rows[0] as Row) : null)),
      ),
    );

  const getMemberByThread = (threadId: string) =>
    wrapSql(
      sql`SELECT * FROM pm_swarm_members WHERE thread_id = ${threadId} LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] ? toMemberRow(rows[0] as Row) : null)),
      ),
    );

  const findSwarmForThread = Effect.fn("SwarmStore.findSwarmForThread")(function* (
    threadId: string,
  ) {
    const member = yield* getMemberByThread(threadId);
    if (member !== null) {
      const swarm = yield* getSwarm(member.swarmId);
      if (swarm === null) return null;
      return { swarm, memberName: member.name, member };
    }
    const swarm = yield* findSwarmByCoordinator(threadId);
    if (swarm !== null) {
      return { swarm, memberName: "coordinator", member: null };
    }
    return null;
  });

  const createSwarm = Effect.fn("SwarmStore.createSwarm")(function* (input: {
    readonly swarmId: string;
    readonly projectId: string;
    readonly coordinatorThreadId: string;
    readonly title: string;
    readonly at: string;
  }) {
    yield* wrapSql(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO pm_swarms (swarm_id, project_id, coordinator_thread_id, title, status, next_seq, created_at, updated_at)
            VALUES (${input.swarmId}, ${input.projectId}, ${input.coordinatorThreadId}, ${input.title}, 'active', 1, ${input.at}, ${input.at})
          `;
          yield* sql`
            INSERT INTO pm_swarm_channels (swarm_id, name, topic, archived, created_by, created_at)
            VALUES (${input.swarmId}, 'main', 'Swarm coordination channel', 0, 'coordinator', ${input.at})
          `;
        }),
      ),
    );
    return {
      swarmId: input.swarmId,
      projectId: input.projectId,
      coordinatorThreadId: input.coordinatorThreadId,
      title: input.title,
      status: "active" as const,
      nextSeq: 1,
      createdAt: input.at,
      updatedAt: input.at,
    };
  });

  const setSwarmTitle = (swarmId: string, title: string, at: string) =>
    wrapSql(
      sql`UPDATE pm_swarms SET title = ${title}, updated_at = ${at} WHERE swarm_id = ${swarmId}`.pipe(
        Effect.asVoid,
      ),
    );

  const setSwarmStatus = (swarmId: string, status: "active" | "done", at: string) =>
    wrapSql(
      sql`UPDATE pm_swarms SET status = ${status}, updated_at = ${at} WHERE swarm_id = ${swarmId}`.pipe(
        Effect.asVoid,
      ),
    );

  const listMembers = (swarmId: string) =>
    wrapSql(
      sql`SELECT * FROM pm_swarm_members WHERE swarm_id = ${swarmId} ORDER BY created_at, name`.pipe(
        Effect.map((rows) => rows.map((row) => toMemberRow(row as Row))),
      ),
    );

  const getMember = (swarmId: string, name: string) =>
    wrapSql(
      sql`SELECT * FROM pm_swarm_members WHERE swarm_id = ${swarmId} AND name = ${name} LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] ? toMemberRow(rows[0] as Row) : null)),
      ),
    );

  const insertMember = (member: SwarmMemberRow) =>
    wrapSql(
      sql`
        INSERT INTO pm_swarm_members (
          swarm_id, name, thread_id, role, workspace_mode, channels_json, primary_channel,
          added_by, state, wait_since_seq, mentions_only, created_at
        ) VALUES (
          ${member.swarmId}, ${member.name}, ${member.threadId}, ${member.role},
          ${member.workspaceMode}, ${JSON.stringify(member.channels)}, ${member.primaryChannel},
          ${member.addedBy}, ${member.state}, ${member.waitSinceSeq},
          ${member.mentionsOnly ? 1 : 0}, ${member.createdAt}
        )
      `.pipe(Effect.asVoid),
    );

  const updateMemberState = (input: {
    readonly swarmId: string;
    readonly name: string;
    readonly state: SwarmMemberState;
    readonly waitSinceSeq?: number | undefined;
    readonly mentionsOnly?: boolean | undefined;
  }) =>
    wrapSql(
      Effect.gen(function* () {
        if (input.waitSinceSeq !== undefined && input.mentionsOnly !== undefined) {
          yield* sql`
            UPDATE pm_swarm_members
            SET state = ${input.state}, wait_since_seq = ${input.waitSinceSeq}, mentions_only = ${input.mentionsOnly ? 1 : 0}
            WHERE swarm_id = ${input.swarmId} AND name = ${input.name}
          `;
        } else if (input.waitSinceSeq !== undefined) {
          yield* sql`
            UPDATE pm_swarm_members
            SET state = ${input.state}, wait_since_seq = ${input.waitSinceSeq}
            WHERE swarm_id = ${input.swarmId} AND name = ${input.name}
          `;
        } else {
          yield* sql`
            UPDATE pm_swarm_members SET state = ${input.state}
            WHERE swarm_id = ${input.swarmId} AND name = ${input.name}
          `;
        }
      }),
    );

  const updateMemberChannels = (input: {
    readonly swarmId: string;
    readonly name: string;
    readonly channels: ReadonlyArray<string>;
    readonly primaryChannel?: string | undefined;
  }) =>
    wrapSql(
      input.primaryChannel !== undefined
        ? sql`
            UPDATE pm_swarm_members
            SET channels_json = ${JSON.stringify(input.channels)}, primary_channel = ${input.primaryChannel}
            WHERE swarm_id = ${input.swarmId} AND name = ${input.name}
          `.pipe(Effect.asVoid)
        : sql`
            UPDATE pm_swarm_members
            SET channels_json = ${JSON.stringify(input.channels)}
            WHERE swarm_id = ${input.swarmId} AND name = ${input.name}
          `.pipe(Effect.asVoid),
    );

  const listChannels = (swarmId: string) =>
    wrapSql(
      sql`SELECT * FROM pm_swarm_channels WHERE swarm_id = ${swarmId} ORDER BY created_at, name`.pipe(
        Effect.map((rows) => rows.map((row) => toChannelRow(row as Row))),
      ),
    );

  const upsertChannel = (channel: SwarmChannelRow) =>
    wrapSql(
      sql`
        INSERT INTO pm_swarm_channels (swarm_id, name, topic, archived, created_by, created_at)
        VALUES (${channel.swarmId}, ${channel.name}, ${channel.topic}, ${channel.archived ? 1 : 0}, ${channel.createdBy}, ${channel.createdAt})
        ON CONFLICT (swarm_id, name) DO UPDATE SET topic = excluded.topic
      `.pipe(Effect.asVoid),
    );

  const archiveChannel = (swarmId: string, name: string) =>
    wrapSql(
      sql`UPDATE pm_swarm_channels SET archived = 1 WHERE swarm_id = ${swarmId} AND name = ${name}`.pipe(
        Effect.asVoid,
      ),
    );

  const appendPost = Effect.fn("SwarmStore.appendPost")(function* (input: {
    readonly swarmId: string;
    readonly channel: string;
    readonly sender: string;
    readonly text: string;
    readonly mentions: ReadonlyArray<string>;
    readonly at: string;
  }) {
    return yield* wrapSql(
      sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT next_seq FROM pm_swarms WHERE swarm_id = ${input.swarmId} LIMIT 1`;
          const seq = Number((rows[0] as Row | undefined)?.next_seq ?? 1);
          yield* sql`
            UPDATE pm_swarms SET next_seq = ${seq + 1}, updated_at = ${input.at}
            WHERE swarm_id = ${input.swarmId}
          `;
          // @effect-diagnostics-next-line globalJsonInEffect:off - mentions is a string array.
          const mentionsJson = JSON.stringify(input.mentions);
          yield* sql`
            INSERT INTO pm_swarm_posts (swarm_id, seq, channel, sender, text, mentions_json, created_at)
            VALUES (${input.swarmId}, ${seq}, ${input.channel}, ${input.sender}, ${input.text}, ${mentionsJson}, ${input.at})
          `;
          return {
            swarmId: input.swarmId,
            seq,
            channel: input.channel,
            sender: input.sender,
            text: input.text,
            mentions: input.mentions,
            createdAt: input.at,
          } satisfies SwarmPostRow;
        }),
      ),
    );
  });

  const listPosts = (input: {
    readonly swarmId: string;
    readonly since: number;
    readonly channel?: string | undefined;
    readonly limit?: number | undefined;
  }) => {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    return wrapSql(
      (input.channel && input.channel !== "*"
        ? sql`
            SELECT * FROM pm_swarm_posts
            WHERE swarm_id = ${input.swarmId} AND seq > ${input.since} AND (channel = ${input.channel} OR channel = 'main')
            ORDER BY seq ASC LIMIT ${limit}
          `
        : sql`
            SELECT * FROM pm_swarm_posts
            WHERE swarm_id = ${input.swarmId} AND seq > ${input.since}
            ORDER BY seq ASC LIMIT ${limit}
          `
      ).pipe(Effect.map((rows) => rows.map((row) => toPostRow(row as Row)))),
    );
  };

  return {
    getSwarm,
    listActiveSwarms,
    findSwarmByCoordinator,
    getMemberByThread,
    findSwarmForThread,
    createSwarm,
    setSwarmTitle,
    setSwarmStatus,
    listMembers,
    getMember,
    insertMember,
    updateMemberState,
    updateMemberChannels,
    listChannels,
    upsertChannel,
    archiveChannel,
    appendPost,
    listPosts,
  };
});

export const layer = Layer.effect(SwarmStore, make);
