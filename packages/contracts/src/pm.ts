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
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
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

/** A worker on another computer the user linked, by the PM's link to it. */
export const PmWorkerComputer = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Set while that computer does not answer; its reports wait until it does. */
  unreachableSince: Schema.NullOr(Schema.String),
  /** Why the PM no longer follows it: its thread is gone there. */
  lost: Schema.NullOr(Schema.String),
});
export type PmWorkerComputer = typeof PmWorkerComputer.Type;

export const PmRemoteWorkerSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  state: Schema.Literals(["running", "waiting", "idle"]),
  computer: PmWorkerComputer,
});
export type PmRemoteWorkerSummary = typeof PmRemoteWorkerSummary.Type;

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
  /** Workers on other computers: no shell here, so they carry their own title and state. */
  remoteWorkers: Schema.optional(Schema.Array(PmRemoteWorkerSummary)),
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
  /** The Inbox's Archive on its Done row; a later finish shows it again. */
  archivedAt: Schema.optional(Schema.NullOr(Schema.String)),
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
  /** On another computer: its thread is not here, so its title comes from there. */
  title: Schema.optional(Schema.NullOr(Schema.String)),
  computer: Schema.optional(Schema.NullOr(PmWorkerComputer)),
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
  /** First opened by the user: the Inbox draws an opened page's row as read. */
  openedAt: Schema.optional(Schema.NullOr(Schema.String)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.String)),
  /** When it was answered or marked seen, for the Inbox's Recent drawer. */
  settledAt: Schema.optional(Schema.NullOr(Schema.String)),
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
  /** When the PM's newest turn started: the Inbox's Recent drawer holds what it finished. */
  turnStartedAt: Schema.optional(Schema.NullOr(Schema.String)),
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

export const PmSwarmState = Schema.Literals(["active", "done"]);
export type PmSwarmState = typeof PmSwarmState.Type;

export const PmSwarmMemberState = Schema.Literals(["working", "waiting", "stopped", "killed"]);
export type PmSwarmMemberState = typeof PmSwarmMemberState.Type;

export const PmSwarmWorkspaceMode = Schema.Literals(["inherit", "worktree"]);
export type PmSwarmWorkspaceMode = typeof PmSwarmWorkspaceMode.Type;

export const PmSwarm = Schema.Struct({
  swarmId: Schema.String,
  projectId: Schema.String,
  coordinatorThreadId: Schema.String,
  title: Schema.String,
  status: PmSwarmState,
  nextSeq: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PmSwarm = typeof PmSwarm.Type;

export const PmSwarmChannel = Schema.Struct({
  swarmId: Schema.String,
  name: Schema.String,
  topic: Schema.String,
  archived: Schema.Boolean,
  createdBy: Schema.String,
  createdAt: Schema.String,
});
export type PmSwarmChannel = typeof PmSwarmChannel.Type;

export const PmSwarmMember = Schema.Struct({
  swarmId: Schema.String,
  name: Schema.String,
  threadId: Schema.String,
  role: Schema.NullOr(Schema.String),
  workspaceMode: PmSwarmWorkspaceMode,
  channels: Schema.Array(Schema.String),
  primaryChannel: Schema.String,
  addedBy: Schema.String,
  state: PmSwarmMemberState,
  waitSinceSeq: Schema.Number,
  mentionsOnly: Schema.Boolean,
  createdAt: Schema.String,
});
export type PmSwarmMember = typeof PmSwarmMember.Type;

export const PmSwarmPost = Schema.Struct({
  swarmId: Schema.String,
  seq: Schema.Number,
  channel: Schema.String,
  sender: Schema.String,
  text: Schema.String,
  mentions: Schema.Array(Schema.String),
  createdAt: Schema.String,
});
export type PmSwarmPost = typeof PmSwarmPost.Type;

export const PmSwarmBoard = Schema.Struct({
  swarm: PmSwarm,
  members: Schema.Array(PmSwarmMember),
  channels: Schema.Array(PmSwarmChannel),
  posts: Schema.Array(PmSwarmPost),
  viewerRole: Schema.Literals(["coordinator", "member"]),
  viewerName: Schema.String,
});
export type PmSwarmBoard = typeof PmSwarmBoard.Type;

// pipelines: visual agent framework builder & unified cross-model thread harness.
export const PmPipelineTier = Schema.Literals(["small", "mid", "frontier"]);
export type PmPipelineTier = typeof PmPipelineTier.Type;

export const PmPipelineAccess = Schema.Literals(["read-only", "write"]);
export type PmPipelineAccess = typeof PmPipelineAccess.Type;

export const PmPipelineWorkspaceMode = Schema.Literals(["shared", "worktree"]);
export type PmPipelineWorkspaceMode = typeof PmPipelineWorkspaceMode.Type;

export const PmPipelineCandidate = Schema.Struct({
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type PmPipelineCandidate = typeof PmPipelineCandidate.Type;

export const PmPipelineRole = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  tier: PmPipelineTier,
  maxTier: Schema.optional(PmPipelineTier),
  access: PmPipelineAccess,
  multimodal: Schema.optional(Schema.Boolean),
  candidates: Schema.optional(Schema.Array(PmPipelineCandidate)),
  skills: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  contextFiles: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  toolkits: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  outputContract: Schema.optional(TrimmedNonEmptyString),
  instructions: Schema.optional(TrimmedNonEmptyString),
});
export type PmPipelineRole = typeof PmPipelineRole.Type;

export const PmPipelineResolvedModel = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type PmPipelineResolvedModel = typeof PmPipelineResolvedModel.Type;

export const PmPipelineRoleEntry = Schema.Struct({
  role: PmPipelineRole,
  source: Schema.String,
  isBuiltIn: Schema.Boolean,
  isOverridden: Schema.Boolean,
  resolvedModel: Schema.NullOr(PmPipelineResolvedModel),
  resolvedNote: Schema.NullOr(Schema.String),
});
export type PmPipelineRoleEntry = typeof PmPipelineRoleEntry.Type;

export const PmPipelineStage = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: Schema.optional(TrimmedNonEmptyString),
  goal: TrimmedNonEmptyString,
  reads: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  produces: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  workspace: Schema.optional(PmPipelineWorkspaceMode),
  parallel: Schema.optional(Schema.Number),
  foreach: Schema.optional(Schema.Literal("each-task")),
  differentProviderFrom: Schema.optional(TrimmedNonEmptyString),
  approval: Schema.optional(Schema.Boolean),
  skipWhen: Schema.optional(TrimmedNonEmptyString),
  onFail: Schema.optional(TrimmedNonEmptyString),
  run: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type PmPipelineStage = typeof PmPipelineStage.Type;

export const PmPipelineDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  when: Schema.optional(TrimmedNonEmptyString),
  escalateAfter: Schema.optional(Schema.Number),
  replanAfter: Schema.optional(Schema.Number),
  stages: Schema.Array(PmPipelineStage),
});
export type PmPipelineDefinition = typeof PmPipelineDefinition.Type;

export const PmPipelineEntry = Schema.Struct({
  pipeline: PmPipelineDefinition,
  source: Schema.String,
  isBuiltIn: Schema.Boolean,
  isOverridden: Schema.Boolean,
});
export type PmPipelineEntry = typeof PmPipelineEntry.Type;

export const PmPipelineProviderModel = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  reasoningChoices: Schema.Array(Schema.String),
});
export type PmPipelineProviderModel = typeof PmPipelineProviderModel.Type;

export const PmPipelineProvider = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  models: Schema.Array(PmPipelineProviderModel),
});
export type PmPipelineProvider = typeof PmPipelineProvider.Type;

export const PmDiscoveredSkill = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  scope: Schema.Literals(["project", "user", "plugin"]),
});
export type PmDiscoveredSkill = typeof PmDiscoveredSkill.Type;

export const PmWorkspacePipelinesSnapshot = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.NullOr(Schema.String),
  roles: Schema.Array(PmPipelineRoleEntry),
  pipelines: Schema.Array(PmPipelineEntry),
  providers: Schema.Array(PmPipelineProvider),
  discoveredSkills: Schema.Array(PmDiscoveredSkill),
  problems: Schema.Array(Schema.String),
});
export type PmWorkspacePipelinesSnapshot = typeof PmWorkspacePipelinesSnapshot.Type;

export const PmThreadHarnessState = Schema.Struct({
  threadId: ThreadId,
  roleName: Schema.NullOr(Schema.String),
  trackedSkills: Schema.Array(Schema.String),
  trackedContextFiles: Schema.Array(Schema.String),
  revision: Schema.Number,
  updatedAt: Schema.NullOr(Schema.String),
});
export type PmThreadHarnessState = typeof PmThreadHarnessState.Type;

// pipelines: live pipeline run graph, cost/budget telemetry, app verification gate, A/B eval arena, and self-improving harness learnings.
export const PmPipelineRunStatus = Schema.Literals([
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "budget_paused",
]);
export type PmPipelineRunStatus = typeof PmPipelineRunStatus.Type;

export const PmPipelineStageRunStatus = Schema.Literals([
  "pending",
  "running",
  "waiting_approval",
  "passed",
  "failed",
  "skipped",
]);
export type PmPipelineStageRunStatus = typeof PmPipelineStageRunStatus.Type;

export const PmPipelineStageRun = Schema.Struct({
  runId: Schema.String,
  stageId: Schema.String,
  stageIndex: Schema.Number,
  roleName: Schema.String,
  status: PmPipelineStageRunStatus,
  workerThreadId: Schema.NullOr(ThreadId),
  providerModel: Schema.NullOr(Schema.String),
  tier: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedTokens: Schema.Number,
  costUsd: Schema.Number,
  durationMs: Schema.Number,
  summary: Schema.NullOr(Schema.String),
  artifacts: Schema.Array(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export type PmPipelineStageRun = typeof PmPipelineStageRun.Type;

export const PmPipelineRun = Schema.Struct({
  runId: Schema.String,
  projectId: ProjectId,
  pmThreadId: Schema.NullOr(ThreadId),
  pipelineName: Schema.String,
  goal: Schema.String,
  status: PmPipelineRunStatus,
  budgetUsd: Schema.NullOr(Schema.Number),
  spentUsd: Schema.Number,
  baselineFrontierUsd: Schema.Number,
  savingsPercent: Schema.Number,
  cacheHitPercent: Schema.Number,
  stages: Schema.Array(PmPipelineStageRun),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type PmPipelineRun = typeof PmPipelineRun.Type;

export const PmAppVerifyTargetKind = Schema.Literals([
  "website",
  "web_app",
  "fullstack_app",
  "cli_or_api",
]);
export type PmAppVerifyTargetKind = typeof PmAppVerifyTargetKind.Type;

export const PmAppVerifyCheck = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  passed: Schema.Boolean,
  summary: Schema.String,
});
export type PmAppVerifyCheck = typeof PmAppVerifyCheck.Type;

export const PmAppVerifyScreenshot = Schema.Struct({
  viewport: Schema.String,
  route: Schema.String,
  path: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  horizontalOverflow: Schema.Boolean,
});
export type PmAppVerifyScreenshot = typeof PmAppVerifyScreenshot.Type;

export const PmAppVerifyA11yIssue = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  route: Schema.String,
  rule: Schema.String,
  message: Schema.String,
  count: Schema.Number,
});
export type PmAppVerifyA11yIssue = typeof PmAppVerifyA11yIssue.Type;

export const PmAppVerifyReport = Schema.Struct({
  passed: Schema.Boolean,
  targetKind: PmAppVerifyTargetKind,
  checkedAt: Schema.String,
  durationMs: Schema.Number,
  checks: Schema.Array(PmAppVerifyCheck),
  routesChecked: Schema.Array(
    Schema.Struct({
      route: Schema.String,
      status: Schema.Number,
      ok: Schema.Boolean,
      latencyMs: Schema.Number,
    }),
  ),
  screenshots: Schema.Array(PmAppVerifyScreenshot),
  consoleErrors: Schema.Array(Schema.String),
  a11yIssues: Schema.Array(PmAppVerifyA11yIssue),
  browserUsed: Schema.Boolean,
  browserNote: Schema.NullOr(Schema.String),
  reportPath: Schema.NullOr(Schema.String),
  summary: Schema.String,
});
export type PmAppVerifyReport = typeof PmAppVerifyReport.Type;

export const PmEvalArmMetrics = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  status: Schema.String,
  modelLabel: Schema.String,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedTokens: Schema.Number,
  cacheHitPercent: Schema.Number,
  estimatedCostUsd: Schema.Number,
  durationMs: Schema.Number,
  humanInterventions: Schema.Number,
  filesChanged: Schema.Number,
  insertions: Schema.Number,
  deletions: Schema.Number,
  verify: Schema.NullOr(PmAppVerifyReport),
});
export type PmEvalArmMetrics = typeof PmEvalArmMetrics.Type;

export const PmEvalRun = Schema.Struct({
  evalId: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  prompt: Schema.String,
  targetKind: PmAppVerifyTargetKind,
  treatmentPipeline: Schema.String,
  verifyCommands: Schema.Array(Schema.String),
  verifyStartCommand: Schema.NullOr(Schema.String),
  verifyUrl: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "completed", "failed"]),
  baseline: PmEvalArmMetrics,
  treatment: PmEvalArmMetrics,
  costDeltaPercent: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PmEvalRun = typeof PmEvalRun.Type;

export const PmHarnessLearningCategory = Schema.Literals([
  "bug_pattern",
  "style_rule",
  "verification",
  "architecture",
  "skill_gap",
]);
export type PmHarnessLearningCategory = typeof PmHarnessLearningCategory.Type;

export const PmHarnessLearningStatus = Schema.Literals(["proposed", "applied", "dismissed"]);
export type PmHarnessLearningStatus = typeof PmHarnessLearningStatus.Type;

export const PmHarnessLearning = Schema.Struct({
  learningId: Schema.String,
  projectId: ProjectId,
  roleName: Schema.String,
  sourceRunId: Schema.NullOr(Schema.String),
  sourceThreadId: Schema.NullOr(ThreadId),
  category: PmHarnessLearningCategory,
  title: Schema.String,
  ruleText: Schema.String,
  status: PmHarnessLearningStatus,
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type PmHarnessLearning = typeof PmHarnessLearning.Type;

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
  pageOpen: "pm.page.open",
  pageSnooze: "pm.page.snooze",
  pageReopen: "pm.page.reopen",
  itemArchive: "pm.item.archive",
  settingsGet: "pm.settings.get",
  settingsSet: "pm.settings.set",
  convert: "pm.convert",
  revert: "pm.revert",
  t3Status: "pm.t3.status",
  t3SetSync: "pm.t3.setSync",
  t3Import: "pm.t3.import",
  swarmGet: "pm.swarm.get",
  swarmPost: "pm.swarm.post",
  pipelinesGet: "pm.pipelines.get",
  roleSave: "pm.pipelines.roleSave",
  roleDelete: "pm.pipelines.roleDelete",
  pipelineSave: "pm.pipelines.pipelineSave",
  pipelineDelete: "pm.pipelines.pipelineDelete",
  threadHarnessGet: "pm.harness.get",
  threadHarnessSet: "pm.harness.set",
  pipelineRunsList: "pm.pipelines.runsList",
  pipelineRunStart: "pm.pipelines.runStart",
  pipelineStageDecide: "pm.pipelines.stageDecide",
  appVerifyRun: "pm.verify.run",
  evalRunsList: "pm.eval.list",
  evalRunStart: "pm.eval.start",
  evalRunVerify: "pm.eval.verify",
  evalRunDelete: "pm.eval.delete",
  learningsList: "pm.learnings.list",
  learningPropose: "pm.learnings.propose",
  learningApply: "pm.learnings.apply",
  learningDismiss: "pm.learnings.dismiss",
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
  Rpc.make(PM_WS_METHODS.pageOpen, {
    payload: Schema.Struct({ pageId: Schema.String }),
    success: Ok,
    error: PmRpcError,
  }),
  /** `until: null` wakes it. */
  Rpc.make(PM_WS_METHODS.pageSnooze, {
    payload: Schema.Struct({ pageId: Schema.String, until: Schema.NullOr(Schema.String) }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pageReopen, {
    payload: Schema.Struct({ pageId: Schema.String }),
    success: Ok,
    error: PmRpcError,
  }),
  /** `archived: false` is the Undo. */
  Rpc.make(PM_WS_METHODS.itemArchive, {
    payload: Schema.Struct({
      ...PmTarget,
      items: Schema.Array(Schema.Number),
      archived: Schema.Boolean,
    }),
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
  Rpc.make(PM_WS_METHODS.swarmGet, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.NullOr(PmSwarmBoard),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.swarmPost, {
    payload: Schema.Struct({
      threadId: ThreadId,
      text: TrimmedNonEmptyString,
      channel: Schema.optional(TrimmedNonEmptyString),
    }),
    success: PmSwarmPost,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pipelinesGet, {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: PmWorkspacePipelinesSnapshot,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.roleSave, {
    payload: Schema.Struct({
      projectId: ProjectId,
      role: PmPipelineRole,
      previousName: Schema.optional(TrimmedNonEmptyString),
    }),
    success: PmWorkspacePipelinesSnapshot,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.roleDelete, {
    payload: Schema.Struct({
      projectId: ProjectId,
      name: TrimmedNonEmptyString,
    }),
    success: PmWorkspacePipelinesSnapshot,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pipelineSave, {
    payload: Schema.Struct({
      projectId: ProjectId,
      pipeline: PmPipelineDefinition,
      previousName: Schema.optional(TrimmedNonEmptyString),
    }),
    success: PmWorkspacePipelinesSnapshot,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pipelineDelete, {
    payload: Schema.Struct({
      projectId: ProjectId,
      name: TrimmedNonEmptyString,
    }),
    success: PmWorkspacePipelinesSnapshot,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.threadHarnessGet, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: PmThreadHarnessState,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.threadHarnessSet, {
    payload: Schema.Struct({
      threadId: ThreadId,
      roleName: Schema.NullOr(TrimmedNonEmptyString),
      trackedSkills: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      trackedContextFiles: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
    success: PmThreadHarnessState,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pipelineRunsList, {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: Schema.Array(PmPipelineRun),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pipelineRunStart, {
    payload: Schema.Struct({
      projectId: ProjectId,
      pipelineName: TrimmedNonEmptyString,
      goal: Schema.optional(Schema.String),
      budgetUsd: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
    success: PmPipelineRun,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.pipelineStageDecide, {
    payload: Schema.Struct({
      runId: TrimmedNonEmptyString,
      stageId: TrimmedNonEmptyString,
      decision: Schema.Literals(["approve", "reject"]),
      note: Schema.optional(Schema.String),
    }),
    success: PmPipelineRun,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.appVerifyRun, {
    payload: Schema.Struct({
      projectId: ProjectId,
      targetKind: PmAppVerifyTargetKind,
      cwd: Schema.optional(TrimmedNonEmptyString),
      commands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      startCommand: Schema.optional(TrimmedNonEmptyString),
      url: Schema.optional(TrimmedNonEmptyString),
      routes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      runFolder: Schema.optional(TrimmedNonEmptyString),
    }),
    success: PmAppVerifyReport,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.evalRunsList, {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: Schema.Array(PmEvalRun),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.evalRunStart, {
    payload: Schema.Struct({
      projectId: ProjectId,
      title: TrimmedNonEmptyString,
      prompt: TrimmedNonEmptyString,
      targetKind: PmAppVerifyTargetKind,
      baselineModelSelection: ModelSelection,
      treatmentPipeline: TrimmedNonEmptyString,
      verifyCommands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      verifyStartCommand: Schema.optional(TrimmedNonEmptyString),
      verifyUrl: Schema.optional(TrimmedNonEmptyString),
    }),
    success: PmEvalRun,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.evalRunVerify, {
    payload: Schema.Struct({
      evalId: TrimmedNonEmptyString,
    }),
    success: PmEvalRun,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.evalRunDelete, {
    payload: Schema.Struct({
      evalId: TrimmedNonEmptyString,
    }),
    success: Ok,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.learningsList, {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: Schema.Array(PmHarnessLearning),
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.learningPropose, {
    payload: Schema.Struct({
      projectId: ProjectId,
      roleName: TrimmedNonEmptyString,
      category: PmHarnessLearningCategory,
      title: TrimmedNonEmptyString,
      ruleText: TrimmedNonEmptyString,
      sourceRunId: Schema.optional(TrimmedNonEmptyString),
      sourceThreadId: Schema.optional(ThreadId),
    }),
    success: PmHarnessLearning,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.learningApply, {
    payload: Schema.Struct({ learningId: TrimmedNonEmptyString }),
    success: PmHarnessLearning,
    error: PmRpcError,
  }),
  Rpc.make(PM_WS_METHODS.learningDismiss, {
    payload: Schema.Struct({ learningId: TrimmedNonEmptyString }),
    success: PmHarnessLearning,
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
  [PM_WS_METHODS.pageOpen]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pageSnooze]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pageReopen]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.itemArchive]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.settingsSet]: AuthSettingsWriteScope,
  [PM_WS_METHODS.convert]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.revert]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.t3SetSync]: AuthSettingsWriteScope,
  [PM_WS_METHODS.t3Import]: AuthSettingsWriteScope,
  [PM_WS_METHODS.swarmPost]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.roleSave]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.roleDelete]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pipelineSave]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pipelineDelete]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.threadHarnessSet]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pipelineRunStart]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.pipelineStageDecide]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.appVerifyRun]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.evalRunStart]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.evalRunVerify]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.evalRunDelete]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.learningPropose]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.learningApply]: AuthOrchestrationOperateScope,
  [PM_WS_METHODS.learningDismiss]: AuthOrchestrationOperateScope,
} as const;

/** Read methods; with the guarded ones above, every `pm.*` method has exactly one scope. */
export const PM_READ_RPC_SCOPES = {
  [PM_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.pageGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.settingsGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.t3Status]: AuthSettingsWriteScope,
  [PM_WS_METHODS.swarmGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.pipelinesGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.threadHarnessGet]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.pipelineRunsList]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.evalRunsList]: AuthOrchestrationReadScope,
  [PM_WS_METHODS.learningsList]: AuthOrchestrationReadScope,
} as const;
