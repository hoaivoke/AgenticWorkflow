// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads Antigravity SQLite session databases read-only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as DateTime from "effect/DateTime";

import { protoFields } from "../provider/acp/AntigravityChildWork.ts";
import type { AgentSessionThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

// Field numbers from Antigravity trajectory protos (exa.cortex_pb).
const STEP_METADATA = 5;
const METADATA_TIMESTAMP = 1;
const TIMESTAMP_SECONDS = 1;
const STEP_USER_INPUT = 19;
const USER_INPUT_RESPONSE = 2;
const USER_INPUT_ITEMS = 3;
const USER_INPUT_ITEM_TEXT = 1;
const STEP_PLANNER_RESPONSE = 20;
const PLANNER_RESPONSE_TEXT = 1;
const PLANNER_MODIFIED_RESPONSE_TEXT = 8;

const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;

// TrajectoryMetadata fields in trajectory_metadata_blob.
const TRAJECTORY_WORKSPACES = 1;
const WORKSPACE_URI = 1;
const TRAJECTORY_WORKSPACE_URIS = 7;

const MAX_METADATA_BLOB_BYTES = 1024 * 1024;
const MAX_STEP_BYTES = 4 * 1024 * 1024;
const MAX_IMPORTED_MESSAGES = 200;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8Decoder = new TextDecoder("utf-8");

function readVarintField(bytes: Uint8Array, targetField: number): number | undefined {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated varint");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("Overlong varint");
  };
  while (offset < bytes.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) {
      const value = varint();
      if (field === targetField) return value;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error("Truncated field");
      offset += length;
    } else {
      throw new Error("Unsupported wire type");
    }
  }
  return undefined;
}

const fieldBytes = (bytes: Uint8Array, target: number): Uint8Array | undefined => {
  try {
    return protoFields(bytes).find(([field]) => field === target)?.[1];
  } catch {
    return undefined;
  }
};

const fieldText = (bytes: Uint8Array | undefined, target: number): string | undefined => {
  if (bytes === undefined) return undefined;
  const raw = fieldBytes(bytes, target);
  if (raw === undefined) return undefined;
  const text = lossyUtf8Decoder.decode(raw).trim();
  return text.length > 0 ? text : undefined;
};

function decodeStepTimestampIso(payload: Uint8Array, fallbackIso: string): string {
  try {
    const metadata = fieldBytes(payload, STEP_METADATA);
    const timestamp = metadata ? fieldBytes(metadata, METADATA_TIMESTAMP) : undefined;
    const seconds = timestamp ? readVarintField(timestamp, TIMESTAMP_SECONDS) : undefined;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
      return fallbackIso;
    }
    return DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));
  } catch {
    return fallbackIso;
  }
}

function decodeWorkspacePathsFromUris(uris: ReadonlyArray<string>): ReadonlyArray<string> {
  const paths: Array<string> = [];
  for (const uri of uris) {
    const trimmed = uri.trim();
    if (!trimmed) continue;
    try {
      if (trimmed.startsWith("file://")) {
        paths.push(NodeURL.fileURLToPath(trimmed));
      } else if (NodePath.isAbsolute(trimmed)) {
        paths.push(trimmed);
      }
    } catch {
      // Ignore malformed URIs.
    }
  }
  return paths;
}

export interface AntigravityConversationSummary {
  readonly conversationId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly lastModifiedAtMs: number | null;
}

/** Reads `conversation_summaries.db` if present beside `conversations/`. */
export function readAntigravitySummaries(
  homePath: string,
): ReadonlyMap<string, AntigravityConversationSummary> {
  const summaries = new Map<string, AntigravityConversationSummary>();
  const dbPath = NodePath.join(homePath, "conversation_summaries.db");
  if (!NodeFS.existsSync(dbPath)) return summaries;
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const rows = database
      .prepare(
        "SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries LIMIT 5000",
      )
      .all();
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const conversationId =
        typeof record.conversation_id === "string" ? record.conversation_id.trim() : "";
      if (!conversationId) continue;
      const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
      let cwd: string | null = null;
      if (
        typeof record.workspace_uris === "string" &&
        record.workspace_uris.trim().startsWith("[")
      ) {
        try {
          const parsed = JSON.parse(record.workspace_uris);
          if (Array.isArray(parsed)) {
            const paths = decodeWorkspacePathsFromUris(
              parsed.filter((entry): entry is string => typeof entry === "string"),
            );
            cwd = paths[0] ?? null;
          }
        } catch {
          // Ignore malformed JSON.
        }
      }
      const parsedTime =
        typeof record.last_modified_time === "string" ? Date.parse(record.last_modified_time) : NaN;
      summaries.set(conversationId, {
        conversationId,
        title: rawTitle.length > 0 ? rawTitle : null,
        cwd,
        lastModifiedAtMs:
          Number.isFinite(parsedTime) && parsedTime > 946684800000 ? parsedTime : null,
      });
    }
  } catch {
    // Ignore locked/missing summaries index.
  } finally {
    database?.close();
  }
  return summaries;
}

/** Extracts workspace CWD from a conversation `.db` (`trajectory_metadata_blob`). */
export function readAntigravityDbCwd(dbPath: string): string | null {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const row = database
      .prepare("SELECT data FROM trajectory_metadata_blob WHERE length(data) <= ? LIMIT 1")
      .get(MAX_METADATA_BLOB_BYTES);
    if (
      typeof row !== "object" ||
      row === null ||
      !("data" in row) ||
      !(row.data instanceof Uint8Array)
    ) {
      return null;
    }
    const uris: Array<string> = [];
    for (const [field, value] of protoFields(row.data)) {
      if (field === TRAJECTORY_WORKSPACES) {
        for (const [nestedField, nestedValue] of protoFields(value)) {
          if (nestedField !== WORKSPACE_URI) continue;
          const uri = utf8Decoder.decode(nestedValue).trim();
          if (uri.length > 0) uris.push(uri);
        }
      } else if (field === TRAJECTORY_WORKSPACE_URIS) {
        const uri = utf8Decoder.decode(value).trim();
        if (uri.length > 0) uris.push(uri);
      }
    }
    return decodeWorkspacePathsFromUris(uris)[0] ?? null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export function parseAntigravityConversationDb(input: {
  readonly filePath: string;
  readonly providerInstanceId: AgentSessionThread["providerInstanceId"];
  readonly sessionId: string;
  readonly lastActiveAtMs: number;
  readonly summary?: AntigravityConversationSummary | undefined;
}): { readonly cwd: string | null; readonly thread: AgentSessionThread | "empty" | null } {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(input.filePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const fallbackTimestamp = DateTime.formatIso(
      DateTime.makeUnsafe(input.summary?.lastModifiedAtMs ?? input.lastActiveAtMs),
    );
    let cwd = input.summary?.cwd ?? null;
    if (cwd === null) {
      const metaRow = database
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE length(data) <= ? LIMIT 1")
        .get(MAX_METADATA_BLOB_BYTES);
      if (
        typeof metaRow === "object" &&
        metaRow !== null &&
        "data" in metaRow &&
        metaRow.data instanceof Uint8Array
      ) {
        const uris: Array<string> = [];
        for (const [field, value] of protoFields(metaRow.data)) {
          if (field === TRAJECTORY_WORKSPACES) {
            for (const [nestedField, nestedValue] of protoFields(value)) {
              if (nestedField === WORKSPACE_URI) {
                uris.push(lossyUtf8Decoder.decode(nestedValue).trim());
              }
            }
          } else if (field === TRAJECTORY_WORKSPACE_URIS) {
            uris.push(lossyUtf8Decoder.decode(value).trim());
          }
        }
        cwd = decodeWorkspacePathsFromUris(uris)[0] ?? null;
      }
    }

    const stepRows = database
      .prepare(
        "SELECT idx, step_type, step_payload FROM steps WHERE step_type IN (?, ?) AND step_format = 0 AND length(step_payload) <= ? ORDER BY idx",
      )
      .all(STEP_TYPE_USER_INPUT, STEP_TYPE_PLANNER_RESPONSE, MAX_STEP_BYTES);

    const allMessages: Array<AgentSessionThreadMessage> = [];
    for (const row of stepRows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const stepType = Number(record.step_type);
      const payload = record.step_payload instanceof Uint8Array ? record.step_payload : undefined;
      if (payload === undefined) continue;
      const createdAt = decodeStepTimestampIso(payload, fallbackTimestamp);
      if (stepType === STEP_TYPE_USER_INPUT) {
        const userInput = fieldBytes(payload, STEP_USER_INPUT);
        const text =
          fieldText(userInput, USER_INPUT_RESPONSE) ??
          fieldText(
            fieldBytes(userInput ?? new Uint8Array(0), USER_INPUT_ITEMS),
            USER_INPUT_ITEM_TEXT,
          );
        if (text) {
          allMessages.push({ role: "user", text, createdAt });
        }
      } else if (stepType === STEP_TYPE_PLANNER_RESPONSE) {
        const planner = fieldBytes(payload, STEP_PLANNER_RESPONSE);
        const text =
          fieldText(planner, PLANNER_MODIFIED_RESPONSE_TEXT) ??
          fieldText(planner, PLANNER_RESPONSE_TEXT);
        if (text) {
          allMessages.push({ role: "assistant", text, createdAt });
        }
      }
    }

    if (allMessages.length === 0) {
      return { cwd, thread: "empty" };
    }
    const firstUser = allMessages.find((message) => message.role === "user");
    if (firstUser === undefined) {
      return { cwd, thread: null };
    }
    const retained =
      allMessages.length <= MAX_IMPORTED_MESSAGES
        ? allMessages
        : [firstUser, ...allMessages.slice(-(MAX_IMPORTED_MESSAGES - 1))];
    const firstLine =
      firstUser.text.trim().split("\n")[0]?.slice(0, 100).trim() || "Imported thread";
    return {
      cwd,
      thread: {
        source: "antigravity",
        providerInstanceId: input.providerInstanceId,
        providerSessionId: input.sessionId,
        title: input.summary?.title ?? firstLine,
        model: null,
        createdAt: retained[0]?.createdAt ?? fallbackTimestamp,
        updatedAt: fallbackTimestamp,
        messages: retained,
        omittedMessageCount: Math.max(0, allMessages.length - retained.length),
      },
    };
  } catch {
    return { cwd: null, thread: null };
  } finally {
    database?.close();
  }
}
