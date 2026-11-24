// t3code-pm: Project Manager threads. Fork-only wire types; upstream servers never serve `pm.*`.
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { MessageId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const PmStoredItemStatus = Schema.Literals(["moving", "later", "finished", "dropped"]);
export type PmShownItemStatus = typeof PmShownItemStatus.Type;
export const PmShownItemStatus = Schema.Literals([
  "dropped",
  "done",
  "blocked",
  "needs_you",
  "in_progress",
  "waiting",
  "not_worked_on",
  "later",
]);
export const PmAskState = Schema.Literals(["open", "answered", "done", "withdrawn", "dismissed"]);
export const PmWorkerState = Schema.Literals(["running", "waiting", "idle", "resolved"]);
export const PmReportKind = Schema.Literals([
  "finished",
  "waiting",
  "quiet",
  "stopped",
  "idle",
  "restarted",
]);
export type PmReportKind = typeof PmReportKind.Type;
export const PmRowState = Schema.Literals(["blocked", "needs_you", "running", "idle"]);
export const PmPageState = Schema.Literals(["open", "answered", "seen", "replaced", "retired"]);

/** One PM in the sidebar. Small on purpose: every client gets every PM. */
export const PmSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  mission: Schema.String,
  openItems: Schema.Number,
  openAsks: Schema.Number,
  workers: Schema.Number,
  runningWorkers: Schema.Number,
  rowState: PmRowState,
  workerThreadIds: Schema.Array(ThreadId),
  /** Workers still not moving a full round after T3 Code nudged them. */
  notMovingWorkerThreadIds: Schema.optional(Schema.Array(ThreadId)),
});
export type PmSummary = typeof PmSummary.Type;

export const PmSubscribeEvent = Schema.Struct({
  enabled: Schema.Boolean,
  pms: Schema.Array(PmSummary),
});
export type PmSubscribeEvent = typeof PmSubscribeEvent.Type;

export const PmMemoryNote = Schema.Struct({
  number: Schema.Number,
  text: Schema.String,
  createdAt: Schema.String,
});

export const PmItemStep = Schema.Struct({
  number: Schema.Number,
  text: Schema.String,
  done: Schema.Boolean,
  chore: Schema.Boolean,
  at: Schema.String,
});

export const PmItemWait = Schema.Struct({
  number: Schema.Number,
  onKind: Schema.Literals(["item", "ask", "text"]),
  onRef: Schema.String,
  since: Schema.String,
  open: Schema.Boolean,
});

export const PmItem = Schema.Struct({
  itemNo: Schema.Number,
  title: Schema.String,
  status: PmStoredItemStatus,
  shownStatus: PmShownItemStatus,
  laterReason: Schema.NullOr(Schema.String),
  nowLine: Schema.NullOr(Schema.String),
  doneLine: Schema.NullOr(Schema.String),
  steps: Schema.Array(PmItemStep),
  waits: Schema.Array(PmItemWait),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  droppedAt: Schema.NullOr(Schema.String),
});
export type PmItem = typeof PmItem.Type;

export const PmAsk = Schema.Struct({
  askNo: Schema.Number,
  itemNo: Schema.NullOr(Schema.Number),
  title: Schema.String,
  detail: Schema.String,
  answers: Schema.Array(Schema.String),
  recommended: Schema.NullOr(Schema.String),
  holds: Schema.Boolean,
  state: PmAskState,
  answer: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  answerMessageId: Schema.NullOr(MessageId),
  createdAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
});
export type PmAsk = typeof PmAsk.Type;

export const PmWorker = Schema.Struct({
  threadId: ThreadId,
  itemNo: Schema.NullOr(Schema.Number),
  state: PmWorkerState,
  linkedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  lastReportKind: Schema.NullOr(PmReportKind),
  lastReportAt: Schema.NullOr(Schema.String),
  lastReportLine: Schema.NullOr(Schema.String),
  /** Set while the worker waits out a usage limit; T3 Code carries it on after this time. */
  limitResetAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** Still not moving a full round after T3 Code nudged it. */
  notMoving: Schema.optional(Schema.Boolean),
});
export type PmWorker = typeof PmWorker.Type;

export const PmLink = Schema.Struct({
  number: Schema.Number,
  itemNo: Schema.NullOr(Schema.Number),
  workerThreadId: Schema.NullOr(ThreadId),
  url: Schema.String,
  kind: Schema.Literals(["pr", "issue", "url"]),
  title: Schema.NullOr(Schema.String),
});

export type PmPageSummary = typeof PmPageSummary.Type;
export const PmPageSummary = Schema.Struct({
  pageId: Schema.String,
  itemNo: Schema.NullOr(Schema.Number),
  sourceName: Schema.String,
  title: Schema.String,
  state: PmPageState,
  questionTags: Schema.Array(Schema.String),
  messageId: Schema.NullOr(MessageId),
  answersMessageId: Schema.NullOr(MessageId),
  createdAt: Schema.String,
});

export const PmReport = Schema.Struct({
  reportId: Schema.String,
  workerThreadId: ThreadId,
  kind: PmReportKind,
  messageId: MessageId,
  line: Schema.String,
  createdAt: Schema.String,
});

/** Everything one open PM view shows. */
export const PmThreadDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  mission: Schema.String,
  instructions: Schema.String,
  memory: Schema.Array(PmMemoryNote),
  items: Schema.Array(PmItem),
  asks: Schema.Array(PmAsk),
  workers: Schema.Array(PmWorker),
  links: Schema.Array(PmLink),
  pages: Schema.Array(PmPageSummary),
  reports: Schema.Array(PmReport),
});
export type PmThreadDetail = typeof PmThreadDetail.Type;

export const PmSettings = Schema.Struct({
  enabled: Schema.Boolean,
  playbookVersion: Schema.Number,
  playbookOverrides: Schema.Array(Schema.String),
});
export type PmSettings = typeof PmSettings.Type;

export class PmError extends Schema.TaggedError<PmError>()("PmError", {
  code: Schema.Literals(["disabled", "not_found", "invalid_request", "conflict", "unavailable"]),
  message: Schema.String,
}) {}

export const PmT3ImportMode = Schema.Literals(["import", "replace"]);
export type PmT3ImportMode = typeof PmT3ImportMode.Type;

/** What Settings, Import from T3 Code shows before anything runs. */
export const PmT3Status = Schema.Struct({
  syncEnabled: Schema.Boolean,
  lastLaunch: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      projectsAdded: Schema.Number,
      settingsChanged: Schema.Number,
      skipped: Schema.NullOr(Schema.String),
    }),
  ),
  source: Schema.NullOr(
    Schema.Struct({
      home: Schema.String,
      threads: Schema.Number,
      projects: Schema.Number,
      /** T3 Code's database is newer than this build: importing is refused. */
      newer: Schema.Boolean,
    }),
  ),
  pmThreads: Schema.Number,
  importedThreads: Schema.Number,
});
export type PmT3Status = typeof PmT3Status.Type;

export const PmT3ImportResult = Schema.Struct({
  mode: PmT3ImportMode,
  before: Schema.Struct({ pmThreads: Schema.Number, t3Threads: Schema.Number }),
  after: Schema.Struct({ pmThreads: Schema.Number }),
  imported: Schema.Number,
  removed: Schema.Number,
  skippedRunning: Schema.Number,
  skippedAlreadyImported: Schema.Number,
  skippedNoProject: Schema.Number,
  skippedConflicts: Schema.Number,
  projectsAdded: Schema.Number,
  checkpointRefsCopied: Schema.Number,
  checkpointRefsFailed: Schema.Number,
  /** Replace only: PM3code's database as it was, to copy back over statev2.sqlite. */
  backupPath: Schema.NullOr(Schema.String),
});
export type PmT3ImportResult = typeof PmT3ImportResult.Type;

const PmRpcError = Schema.Union([PmError, EnvironmentAuthorizationError]);
const PmTarget = { pm: ThreadId };
const Ok = Schema.Struct({});

export const PM_WS_METHODS = {
  subscribe: "pm.subscribe",
  subscribeThread: "pm.subscribeThread",
  create: "pm.create",
  setMission: "pm.setMission",
  setInstructions: "pm.setInstructions",
  remember: "pm.remember",
  forget: "pm.forget",
  editMemory: "pm.editMemory",
  askAnswer: "pm.ask.answer",
  askSnooze: "pm.ask.snooze",
  askWake: "pm.ask.wake",
  askDismiss: "pm.ask.dismiss",
  askUndoDismiss: "pm.ask.undoDismiss",
  pageGet: "pm.page.get",
  pageAnswer: "pm.page.answer",
  pageMarkSeen: "pm.page.markSeen",
  settingsGet: "pm.settings.get",
  settingsSet: "pm.settings.set",
  convert: "pm.convert",
  revert: "pm.revert",
  t3Status: "pm.t3.status",
  t3SetSync: "pm.t3.setSync",
  t3Import: "pm.t3.import",
} as const;

/** The streaming `pm.*` methods, for the client runtime's subscription factory. */
export type PmSubscriptionRpcTag =
  | typeof PM_WS_METHODS.subscribe
  | typeof PM_WS_METHODS.subscribeThread;

const AskTarget = { ...PmTarget, ask: Schema.Number };

export const PmRpcGroup = RpcGroup.make(
  Rpc.make(PM_WS_METHODS.subscribe, {
    payload: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
    success: PmSubscribeEvent,
    error: PmRpcError,
    stream: true,
  }),
  Rpc.make(PM_WS_METHODS.subscribeThread, {
    payload: Schema.Struct(PmTarget),
    success: Schema.NullOr(PmThreadDetail),
    error: PmRpcError,
    stream: true,
  }),
  Rpc.make(PM_WS_METHODS.create, {
    payload: Schema.Struct({
      projectId: ProjectId,
      modelSelection: Schema.optional(ModelSelection),
    }),
    success: Schema.Struct({ threadId: ThreadId }),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.setMission, {
    payload: Schema.Struct({ ...PmTarget, mission: Schema.String }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.setInstructions, {
    payload: Schema.Struct({ ...PmTarget, instructions: Schema.String }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.remember, {
    payload: Schema.Struct({ ...PmTarget, text: TrimmedNonEmptyString }),
    success: Schema.Struct({ number: Schema.Number }),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.forget, {
    payload: Schema.Struct({ ...PmTarget, number: Schema.Number }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.editMemory, {
    payload: Schema.Struct({ ...PmTarget, number: Schema.Number, text: TrimmedNonEmptyString }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.askAnswer, {
    payload: Schema.Struct({ ...AskTarget, answer: TrimmedNonEmptyString }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.askSnooze, {
    payload: Schema.Struct({ ...AskTarget, until: Schema.String }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.askWake, {
    payload: Schema.Struct(AskTarget),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.askDismiss, {
    payload: Schema.Struct(AskTarget),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.askUndoDismiss, {
    payload: Schema.Struct(AskTarget),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pageGet, {
    payload: Schema.Struct({ pageId: Schema.String }),
    success: Schema.Struct({ pageId: Schema.String, title: Schema.String, html: Schema.String }),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pageAnswer, {
    payload: Schema.Struct({ pageId: Schema.String, answers: Schema.Json }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pageMarkSeen, {
    payload: Schema.Struct({ pageId: Schema.String, reply: Schema.optional(Schema.String) }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.settingsGet, {
    payload: Schema.Struct({}),
    success: PmSettings,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.settingsSet, {
    payload: Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      playbookOverrides: Schema.optional(Schema.Array(Schema.String)),
    }),
    success: PmSettings,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.convert, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.revert, {
    payload: Schema.Struct(PmTarget),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.t3Status, {
    payload: Schema.Struct({}),
    success: PmT3Status,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.t3SetSync, {
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: PmT3Status,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.t3Import, {
    payload: Schema.Struct({ mode: PmT3ImportMode }),
    success: PmT3ImportResult,
    error: PmRpcError,
  }),
);

/** What a client needs before it offers a PM action; the server checks `PM_RPC_SCOPES`. */
export const PM_CLIENT_GUARDED_RPC_SCOPES = {
  [PM_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.setMission]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.setInstructions]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.remember]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.forget]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.editMemory]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.askAnswer]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.askSnooze]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.askWake]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.askDismiss]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.askUndoDismiss]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pageAnswer]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pageMarkSeen]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.settingsSet]: AuthSettingsWriteScope,
  [PM_WS_METHODS.convert]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.revert]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.t3SetSync]: AuthSettingsWriteScope,
  [PM_WS_METHODS.t3Import]: AuthSettingsWriteScope,
} as const;

/** Read methods; with the guarded ones above, every `pm.*` method has exactly one scope. */
export const PM_READ_RPC_SCOPES = {
  [PM_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.pageGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.settingsGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.t3Status]: AuthSettingsWriteScope,
} as const;
