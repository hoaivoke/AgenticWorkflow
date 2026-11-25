import { ModelSelection, OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { PipelineService } from "../pipelines/PipelineService.ts";
import { SwarmService } from "./SwarmService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadLaunchService.ThreadLaunchService,
    PipelineService,
    SwarmService,
  ],
};

const SwarmAction = Schema.Literals([
  "status",
  "models",
  "add",
  "kill",
  "title",
  "channel",
  "done",
]);
const SwarmChannelOp = Schema.Literals(["create", "subscribe", "unsubscribe", "list", "archive"]);
const SwarmWorkspace = Schema.Literals(["inherit", "worktree"]);

const SwarmManageTool = Tool.make("swarm", {
  ...shared,
  description:
    "Manage a multi-agent swarm collaborating on a shared message board: `title`, `status`, `models`, `add` (spawn worker(s) with optional `role` harness, `worktree` isolation, `tasks` sharding or `n` copies), `channel` (`create`/`subscribe`/`unsubscribe`/`list`/`archive`), `kill`, or `done`.",
  parameters: Schema.Struct({
    action: SwarmAction,
    title: Schema.optional(TrimmedNonEmptyString),
    name: Schema.optional(TrimmedNonEmptyString),
    brief: Schema.optional(TrimmedNonEmptyString),
    role: Schema.optional(TrimmedNonEmptyString),
    workspace: Schema.optional(SwarmWorkspace),
    channels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    channel: Schema.optional(TrimmedNonEmptyString),
    topic: Schema.optional(TrimmedNonEmptyString),
    op: Schema.optional(SwarmChannelOp),
    n: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
    tasks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    modelSelection: Schema.optional(ModelSelection),
    escalate: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  success: Schema.Struct({ result: Schema.String }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SwarmPostMessageTool = Tool.make("post_message", {
  ...shared,
  description:
    "Post a message to the swarm board. Mention `@<name>`, `@all`, `@#<channel>`, or `@coordinator` to wake sleeping target agents. Refer to prior messages by `#seq` rather than duplicating their text.",
  parameters: Schema.Struct({
    text: TrimmedNonEmptyString,
    channel: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ seq: Schema.Number, result: Schema.String }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SwarmReadBoardTool = Tool.make("read_board", {
  ...shared,
  description:
    'Read posts from the swarm board since `since` sequence number (0 for full history). Pass `channel: "*"` for all channels.',
  parameters: Schema.Struct({
    since: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
    channel: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ headSeq: Schema.Number, result: Schema.String }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SwarmWaitTool = Tool.make("swarm_wait", {
  ...shared,
  description:
    "Park this agent on the swarm board at zero token cost until another member posts an @mention (or any message in subscribed channels if `mentions_only` is false). Call this right before ending your turn when waiting for peers.",
  parameters: Schema.Struct({
    since: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
    mentions_only: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ result: Schema.String }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const SwarmToolkit = Toolkit.make(
  SwarmManageTool,
  SwarmPostMessageTool,
  SwarmReadBoardTool,
  SwarmWaitTool,
);
