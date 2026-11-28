import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadShell,
  PmError,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  detectModelFamily,
  matchSkillsForRole,
  renderPipeline,
  renderRoleBrief,
  resolveRole,
  type ModelFamily,
} from "@t3tools/pipelines";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { PipelineService } from "../pipelines/PipelineService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import {
  SwarmStore,
  type SwarmChannelRow,
  type SwarmMemberRow,
  type SwarmMemberState,
  type SwarmPostRow,
  type SwarmRow,
} from "./SwarmStore.ts";

const WORKER_NAME_RE = /^(?!all$|coordinator$|coordinator-)[a-z0-9][a-z0-9_-]{0,23}$/;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const RUNNING_STATUSES = new Set(["preparing", "queued", "starting", "running"]);
const STOPPED_STATUSES = new Set(["interrupted", "failed", "cancelled"]);
const SWARM_STALL_AFTER_MS = 8 * 60_000;
const FORK_CONTEXT_CHAR_LIMIT = 6_000;

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const invalid = (message: string) => new PmError({ code: "invalid_request", message });
const notFound = (message: string) => new PmError({ code: "not_found", message });
const conflict = (message: string) => new PmError({ code: "conflict", message });
const unavailable = (message: string) => () => new PmError({ code: "unavailable", message });
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export interface SwarmBoardSnapshot {
  readonly swarm: SwarmRow;
  readonly members: ReadonlyArray<SwarmMemberRow>;
  readonly channels: ReadonlyArray<SwarmChannelRow>;
  readonly posts: ReadonlyArray<SwarmPostRow>;
  readonly viewerRole: "coordinator" | "member";
  readonly viewerName: string;
}

export interface SwarmManageInput {
  readonly action:
    | "status"
    | "models"
    | "pipeline"
    | "model"
    | "add"
    | "kill"
    | "title"
    | "channel"
    | "done";
  readonly title?: string | undefined;
  readonly pipeline?: string | undefined;
  readonly goal?: string | undefined;
  readonly name?: string | undefined;
  readonly fork?: string | undefined;
  readonly brief?: string | undefined;
  readonly role?: string | undefined;
  readonly workspace?: "inherit" | "worktree" | undefined;
  readonly channels?: ReadonlyArray<string> | undefined;
  readonly channel?: string | undefined;
  readonly topic?: string | undefined;
  readonly op?: "create" | "subscribe" | "unsubscribe" | "list" | "archive" | undefined;
  readonly n?: number | undefined;
  readonly tasks?: ReadonlyArray<string> | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly escalate?: number | undefined;
}

const BIG_THREE_FAMILIES: ReadonlyArray<ModelFamily> = ["claude", "codex", "gemini"];

function extractBoundPipeline(channels: ReadonlyArray<SwarmChannelRow>): string | null {
  const main = channels.find((c) => c.name === "main");
  if (!main) return null;
  const match = /^pipeline:([a-z0-9][a-z0-9_-]*)/i.exec(main.topic.trim());
  return match?.[1] ?? null;
}

function parseMentions(text: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const mentions: Array<string> = [];
  for (const match of text.matchAll(/(?:^|\s)@(#?[a-z0-9][a-z0-9_-]*)/giu)) {
    const token = match[1]?.toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    mentions.push(token);
  }
  return mentions;
}

function formatBoardPosts(posts: ReadonlyArray<SwarmPostRow>): string {
  if (posts.length === 0) return "(no new posts)";
  return posts
    .map((post) => `[#${post.seq} #${post.channel} @${post.sender}] ${post.text}`)
    .join("\n\n");
}

function renderSwarmWorkerEnvelope(input: {
  readonly swarmTitle: string;
  readonly memberName: string;
  readonly coordinatorThreadId: string;
  readonly primaryChannel: string;
  readonly rolePreamble?: string | undefined;
  readonly brief: string;
}): string {
  const lines = [
    ...(input.rolePreamble ? [input.rolePreamble, ""] : []),
    `## Swarm member: @${input.memberName}`,
    input.swarmTitle
      ? `Swarm: ${input.swarmTitle}`
      : `Swarm coordinator: ${input.coordinatorThreadId}`,
    `Your primary channel is #${input.primaryChannel}.`,
    "",
    "Swarm rules:",
    "- Use `post_message` to collaborate on the shared board. Start a post with `@<recipient>` so the right peer or `@coordinator` wakes up.",
    "- Use `post_message` starting with `@coordinator [done]` (or the next peer `@verifier` / author) when your piece is finished or blocked.",
    "- Refer to earlier board messages by `#seq` (`#4`) instead of copying reports verbatim.",
    "- Call `swarm_wait` right before ending your turn whenever you are waiting on another agent so you park at zero token cost.",
    "- Never run git push or delete shared branches unless explicitly asked.",
    "",
    "## Assignment",
    input.brief.trim(),
  ];
  return lines.join("\n");
}

const make = Effect.gen(function* () {
  const store = yield* SwarmStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const pipelines = yield* PipelineService;
  const changes = yield* PubSub.unbounded<string>();

  const newId = Effect.gen(function* () {
    const ms = yield* Clock.currentTimeMillis;
    const salt = yield* Random.nextIntBetween(0, 2 ** 31);
    return `${ms.toString(36)}${salt.toString(36).padStart(6, "0")}`;
  });

  const changed = (swarmId: string) => PubSub.publish(changes, swarmId).pipe(Effect.asVoid);

  const shellOf = (threadId: string) =>
    threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError(unavailable(`Could not read thread ${threadId}.`)));

  const dispatchWakeup = Effect.fn("SwarmService.dispatchWakeup")(function* (input: {
    readonly targetThreadId: string;
    readonly swarmId: string;
    readonly key: string;
    readonly text: string;
    readonly senderThreadId?: string | undefined;
  }) {
    const messageId = MessageId.make(`message:swarm:${input.key}`);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:swarm:${input.key}`),
        threadId: ThreadId.make(input.targetThreadId),
        messageId,
        text: input.text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
        ...(input.senderThreadId === undefined
          ? {}
          : { senderThreadId: ThreadId.make(input.senderThreadId) }),
      })
      .pipe(Effect.ignore({ log: true }));
  });

  const ensureCoordinatorSwarm = Effect.fn("SwarmService.ensureCoordinatorSwarm")(function* (
    callerThreadId: string,
    defaultTitle?: string,
  ) {
    const existing = yield* store.findSwarmForThread(callerThreadId);
    if (existing !== null) return existing;
    const shell = yield* shellOf(callerThreadId);
    if (shell === null) return yield* notFound(`Thread ${callerThreadId} is gone.`);
    const swarm = yield* store.createSwarm({
      swarmId: `swarm-${yield* newId}`,
      projectId: shell.projectId,
      coordinatorThreadId: callerThreadId,
      title: defaultTitle?.trim() || shell.title || "Swarm",
      at: yield* nowIso,
    });
    return { swarm, memberName: "coordinator", member: null } as const;
  });

  const deliverBoardWakeups = Effect.fn("SwarmService.deliverBoardWakeups")(function* (input: {
    readonly swarm: SwarmRow;
    readonly post: SwarmPostRow;
    readonly members: ReadonlyArray<SwarmMemberRow>;
    readonly senderThreadId?: string | undefined;
  }) {
    const mentionSet = new Set(input.post.mentions);
    const allBroadcast = mentionSet.has("all");
    const channelBroadcast = mentionSet.has(`#${input.post.channel.toLowerCase()}`);

    const wakeMember = (member: SwarmMemberRow) => {
      if (member.state === "killed" || member.name === input.post.sender) return false;
      const targeted =
        allBroadcast ||
        mentionSet.has(member.name.toLowerCase()) ||
        Array.from(mentionSet).some(
          (tag) => !tag.startsWith("#") && member.name.toLowerCase().startsWith(`${tag}-`),
        ) ||
        (channelBroadcast && member.channels.includes(input.post.channel));
      const passiveChannelMatch =
        !member.mentionsOnly &&
        (input.post.channel === "main" || member.channels.includes(input.post.channel));
      return targeted || passiveChannelMatch;
    };

    for (const member of input.members) {
      if (!wakeMember(member)) continue;
      if (member.state !== "working") {
        yield* store.updateMemberState({
          swarmId: input.swarm.swarmId,
          name: member.name,
          state: "working",
        });
      }
      const id = yield* newId;
      const sincePosts = yield* store.listPosts({
        swarmId: input.swarm.swarmId,
        since: member.waitSinceSeq,
        channel: member.primaryChannel,
        limit: 40,
      });
      const include = sincePosts.some((p) => p.seq === input.post.seq)
        ? sincePosts
        : [...sincePosts, input.post];
      yield* dispatchWakeup({
        targetThreadId: member.threadId,
        swarmId: input.swarm.swarmId,
        key: `${input.swarm.swarmId}-${input.post.seq}-${member.name}-${id}`,
        senderThreadId: input.senderThreadId,
        text: [
          `<swarm_wakeup swarm="${input.swarm.title || input.swarm.swarmId}" as="@${member.name}">`,
          `Board update on #${input.post.channel}:`,
          "",
          formatBoardPosts(include),
          "</swarm_wakeup>",
        ].join("\n"),
      });
    }

    const wakeCoordinator =
      input.post.sender !== "coordinator" &&
      (mentionSet.has("coordinator") ||
        allBroadcast ||
        channelBroadcast ||
        /^\[done\]/i.test(input.post.text) ||
        /^\[stall\]/i.test(input.post.text));
    if (wakeCoordinator) {
      const id = yield* newId;
      yield* dispatchWakeup({
        targetThreadId: input.swarm.coordinatorThreadId,
        swarmId: input.swarm.swarmId,
        key: `${input.swarm.swarmId}-${input.post.seq}-coord-${id}`,
        senderThreadId: input.senderThreadId,
        text: [
          `<swarm_wakeup swarm="${input.swarm.title || input.swarm.swarmId}" as="@coordinator">`,
          formatBoardPosts([input.post]),
          "</swarm_wakeup>",
        ].join("\n"),
      });
    }
  });

  const postMessage = Effect.fn("SwarmService.postMessage")(function* (
    callerThreadId: string,
    input: { readonly text: string; readonly channel?: string | undefined },
  ) {
    const ctx = yield* store.findSwarmForThread(callerThreadId);
    if (ctx === null) {
      return yield* invalid(
        'This thread is not part of a swarm. Start a swarm first with `swarm { action: "add", ... }`.',
      );
    }
    const channel = (input.channel?.trim() || ctx.member?.primaryChannel || "main").replace(
      /^#/,
      "",
    );
    const at = yield* nowIso;
    const mentions = parseMentions(input.text);
    const post = yield* store.appendPost({
      swarmId: ctx.swarm.swarmId,
      channel,
      sender: ctx.memberName,
      text: input.text.trim(),
      mentions,
      at,
    });
    const members = yield* store.listMembers(ctx.swarm.swarmId);
    yield* deliverBoardWakeups({
      swarm: ctx.swarm,
      post,
      members,
      senderThreadId: callerThreadId,
    });
    yield* changed(ctx.swarm.swarmId);
    return {
      seq: post.seq,
      result: `Posted #${post.seq} to #${post.channel}${mentions.length > 0 ? ` (mentions: ${mentions.map((m) => `@${m}`).join(", ")})` : ""}.`,
    };
  });

  const readBoard = Effect.fn("SwarmService.readBoard")(function* (
    callerThreadId: string,
    input: { readonly since?: number | undefined; readonly channel?: string | undefined },
  ) {
    const ctx = yield* store.findSwarmForThread(callerThreadId);
    if (ctx === null) {
      return yield* invalid("This thread is not part of a swarm.");
    }
    const since = input.since ?? 0;
    const channelFilter =
      input.channel !== undefined
        ? input.channel.replace(/^#/, "")
        : ctx.member === null
          ? "*"
          : ctx.member.primaryChannel;
    const posts = yield* store.listPosts({
      swarmId: ctx.swarm.swarmId,
      since,
      channel: channelFilter,
    });
    const headSeq = posts.at(-1)?.seq ?? Math.max(ctx.swarm.nextSeq - 1, since);
    return {
      headSeq,
      result:
        posts.length === 0
          ? `No posts after #${since} (head #${headSeq}).`
          : `Board posts (${posts.length}, head #${headSeq}):\n\n${formatBoardPosts(posts)}`,
    };
  });

  const swarmWait = Effect.fn("SwarmService.swarmWait")(function* (
    callerThreadId: string,
    input: { readonly since?: number | undefined; readonly mentionsOnly?: boolean | undefined },
  ) {
    const ctx = yield* store.findSwarmForThread(callerThreadId);
    if (ctx === null) {
      return yield* invalid("This thread is not part of a swarm.");
    }
    if (ctx.member === null) {
      return {
        result:
          "Coordinator is now parked at zero cost. End your turn; new board posts mentioning `@coordinator` or marked `[done]` will wake this thread.",
      };
    }
    const headSeq = Math.max(0, ctx.swarm.nextSeq - 1);
    const waitSinceSeq = input.since ?? headSeq;
    yield* store.updateMemberState({
      swarmId: ctx.swarm.swarmId,
      name: ctx.member.name,
      state: "waiting",
      waitSinceSeq,
      mentionsOnly: input.mentionsOnly ?? true,
    });
    yield* changed(ctx.swarm.swarmId);
    return {
      result: `Parked @${ctx.member.name} in waiting state from #${waitSinceSeq}. End your turn now; you will wake at zero idle cost when @mentioned.`,
    };
  });

  const swarmAction = Effect.fn("SwarmService.swarmAction")(function* (
    callerThreadId: string,
    callContext: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly linkOrigin?: OrchestrationV2LinkOrigin | undefined;
    },
    input: SwarmManageInput,
  ) {
    if (input.action === "models") {
      const providers = yield* pipelines.providers;
      const lines = providers
        .filter((p) => p.enabled)
        .map(
          (p) =>
            `- ${p.instanceId} (${p.driver}): ${p.models.map((m) => m.slug).join(", ") || "no models"}`,
        );
      return {
        result: lines.length === 0 ? "No enabled providers with models." : lines.join("\n"),
      };
    }

    const ctx = yield* ensureCoordinatorSwarm(
      callerThreadId,
      input.action === "title" ? input.title : undefined,
    );
    const { swarm, memberName } = ctx;

    if (input.action === "title") {
      if (memberName !== "coordinator") {
        return yield* invalid("Only the swarm coordinator can set the swarm title.");
      }
      const nextTitle = input.title?.trim() ?? "";
      if (!nextTitle) return yield* invalid("Pass `title` when calling action `title`.");
      yield* store.setSwarmTitle(swarm.swarmId, nextTitle, yield* nowIso);
      yield* changed(swarm.swarmId);
      return { result: `Swarm titled "${nextTitle}".` };
    }

    if (input.action === "done") {
      if (memberName !== "coordinator") {
        return yield* invalid("Only the coordinator can mark a swarm done.");
      }
      yield* store.setSwarmStatus(swarm.swarmId, "done", yield* nowIso);
      yield* changed(swarm.swarmId);
      return { result: `Swarm "${swarm.title || swarm.swarmId}" marked done.` };
    }

    if (input.action === "status") {
      const members = yield* store.listMembers(swarm.swarmId);
      const channels = yield* store.listChannels(swarm.swarmId);
      const headSeq = Math.max(0, swarm.nextSeq - 1);
      const boundPipeline = extractBoundPipeline(channels);
      const memberLines =
        members.length === 0
          ? ["(no workers added yet)"]
          : members.map(
              (m) =>
                `- @${m.name} [${m.state}]${m.role ? ` role=${m.role}` : ""} workspace=${m.workspaceMode} channels=${m.channels.map((c) => `#${c}`).join(",")} thread=${m.threadId}`,
            );
      const channelLines = channels.map(
        (c) => `#${c.name}${c.archived ? " (archived)" : ""}${c.topic ? `: ${c.topic}` : ""}`,
      );
      return {
        result: [
          `Swarm: ${swarm.title || swarm.swarmId} (${swarm.status}, head #${headSeq})`,
          ...(boundPipeline ? [`Pipeline: ${boundPipeline}`] : []),
          `Channels: ${channelLines.join(", ")}`,
          "Members:",
          ...memberLines,
        ].join("\n"),
      };
    }

    if (input.action === "pipeline") {
      if (memberName !== "coordinator") {
        return yield* invalid("Only the swarm coordinator can bind a pipeline.");
      }
      const { config, problems } = yield* pipelines.configFor(swarm.projectId);
      const pipelineName = input.pipeline?.trim() ?? "";
      if (!pipelineName) {
        return yield* invalid(
          `Pass \`pipeline\` when calling action \`pipeline\`. Available: ${[...config.pipelines.keys()].join(", ")}.`,
        );
      }
      const pipeline = config.pipelines.get(pipelineName);
      if (pipeline === undefined) {
        return yield* notFound(
          `Unknown pipeline "${pipelineName}". Available: ${[...config.pipelines.keys()].join(", ")}.`,
        );
      }
      const goalText = input.goal?.trim() ?? "";
      const at = yield* nowIso;
      if (!swarm.title.trim() || swarm.title.trim() === "Swarm") {
        const nextTitle = goalText
          ? `${pipeline.name}: ${goalText.slice(0, 60)}`
          : `Pipeline: ${pipeline.name}`;
        yield* store.setSwarmTitle(swarm.swarmId, nextTitle, at);
      }
      yield* store.upsertChannel({
        swarmId: swarm.swarmId,
        name: "main",
        topic: goalText ? `pipeline:${pipeline.name}: ${goalText}` : `pipeline:${pipeline.name}`,
        archived: false,
        createdBy: "coordinator",
        createdAt: at,
      });
      const rendered =
        renderPipeline(config, pipeline.name, problems) ??
        `Pipeline ${pipeline.name}: ${pipeline.description}`;
      const boardText = goalText ? `Goal: ${goalText}\n\n${rendered}` : rendered;
      const post = yield* store.appendPost({
        swarmId: swarm.swarmId,
        channel: "main",
        sender: memberName,
        text: boardText,
        mentions: [],
        at,
      });
      const checklistLines = pipeline.stages.map((stage, index) => {
        const roleName = stage.role ?? "gatekeeper";
        const role = config.roles.get(roleName);
        const tier = role?.tier ?? "?";
        const workspace = stage.workspace ?? "inherit";
        const attrs = [
          `role=${roleName}`,
          `tier=${tier}`,
          `workspace=${workspace}`,
          ...(stage.parallel !== undefined ? [`parallel=${stage.parallel}`] : []),
          ...(stage.differentProviderFrom !== undefined
            ? [`differentProviderFrom=${stage.differentProviderFrom}`]
            : []),
        ];
        const familySkills =
          role === undefined
            ? []
            : BIG_THREE_FAMILIES.map((family) => {
                const matched = matchSkillsForRole({ config, role, modelFamily: family }).map(
                  (s) => s.name,
                );
                return `${family}: ${matched.length > 0 ? matched.join(", ") : "none"}`;
              });
        return [
          `${index + 1}. [${stage.id}] ${attrs.join(" | ")}`,
          `   Goal: ${stage.goal}`,
          ...(familySkills.length > 0 ? [`   Skills (${familySkills.join("; ")})`] : []),
        ].join("\n");
      });
      yield* changed(swarm.swarmId);
      return {
        result: [
          `Bound pipeline "${pipeline.name}" to swarm (posted blueprint as #${post.seq} in #main).`,
          "",
          "Stage checklist:",
          ...checklistLines,
          "",
          rendered,
        ].join("\n"),
      };
    }

    if (input.action === "model") {
      const targetName = input.name?.trim().toLowerCase() ?? "";
      if (!targetName) {
        return yield* invalid("Pass `name` when calling action `model`.");
      }
      const target = yield* store.getMember(swarm.swarmId, targetName);
      if (target === null || target.state === "killed") {
        return yield* notFound(`No active swarm member @${targetName}.`);
      }
      if (
        memberName !== "coordinator" &&
        target.addedBy !== memberName &&
        target.name !== memberName
      ) {
        return yield* invalid(
          `@${memberName} may only switch models for itself or workers it added (@${target.name} was added by @${target.addedBy}).`,
        );
      }
      const targetShell = yield* shellOf(target.threadId);
      if (targetShell === null) {
        return yield* notFound(`Thread ${target.threadId} for @${target.name} is gone.`);
      }

      let nextModelSelection = input.modelSelection;
      if (nextModelSelection === undefined) {
        const { config } = yield* pipelines.configFor(swarm.projectId);
        const roleName =
          target.role && config.roles.has(target.role)
            ? target.role
            : config.roles.has("builder")
              ? "builder"
              : [...config.roles.keys()][0];
        if (!roleName) {
          return yield* invalid("No pipeline roles available to resolve a failover model.");
        }
        const providers = yield* pipelines.providers;
        const limited = yield* pipelines.limitedProviders;
        const currentInstanceId = targetShell.modelSelection.instanceId;
        const currentDriver = providers.find((p) => p.instanceId === currentInstanceId)?.driver;
        const preferDifferentDriver =
          input.escalate === undefined &&
          currentDriver !== undefined &&
          !limited.has(currentInstanceId);
        let resolution = resolveRole({
          config,
          role: roleName,
          providers,
          limited,
          escalate: input.escalate,
          ...(preferDifferentDriver ? { avoidDrivers: [currentDriver] } : {}),
        });
        if (!resolution.ok && preferDifferentDriver) {
          resolution = resolveRole({
            config,
            role: roleName,
            providers,
            limited,
            escalate: input.escalate,
          });
        }
        if (!resolution.ok) {
          return yield* new PmError({
            code: "unavailable",
            message: `Could not resolve a failover model for @${target.name}: ${resolution.reason}`,
          });
        }
        nextModelSelection = decodeModelSelection({
          instanceId: ProviderInstanceId.make(resolution.selection.instanceId),
          model: resolution.selection.model,
          ...(resolution.selection.options.length === 0
            ? {}
            : { options: resolution.selection.options }),
        });
      }

      yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`command:swarm-model:${yield* newId}`),
          threadId: ThreadId.make(target.threadId),
          modelSelection: nextModelSelection,
        })
        .pipe(Effect.mapError(unavailable(`Could not switch model for @${target.name}.`)));

      const nextFamily =
        detectModelFamily(nextModelSelection.model) ??
        detectModelFamily(nextModelSelection.instanceId);
      const at = yield* nowIso;
      const post = yield* store.appendPost({
        swarmId: swarm.swarmId,
        channel: target.primaryChannel,
        sender: memberName,
        text: `@${target.name} model switched to ${nextModelSelection.instanceId}/${nextModelSelection.model}${nextFamily ? ` (${nextFamily} family)` : ""}. Continue your current work without restarting.`,
        mentions: [target.name],
        at,
      });
      const members = yield* store.listMembers(swarm.swarmId);
      yield* deliverBoardWakeups({
        swarm,
        post,
        members,
        senderThreadId: callerThreadId,
      });
      yield* changed(swarm.swarmId);
      return {
        result: `Switched @${target.name} to ${nextModelSelection.instanceId}/${nextModelSelection.model} (post #${post.seq}).`,
      };
    }

    if (input.action === "channel") {
      const op = input.op ?? "list";
      const channels = yield* store.listChannels(swarm.swarmId);
      if (op === "list") {
        return {
          result: channels
            .map(
              (c) => `#${c.name}${c.archived ? " [archived]" : ""}${c.topic ? `: ${c.topic}` : ""}`,
            )
            .join("\n"),
        };
      }
      const ch = input.channel?.trim().replace(/^#/, "").toLowerCase() ?? "";
      if (!ch || !CHANNEL_NAME_RE.test(ch)) {
        return yield* invalid("Channel name must match [a-z0-9][a-z0-9_-]{0,23}.");
      }
      if (op === "create") {
        yield* store.upsertChannel({
          swarmId: swarm.swarmId,
          name: ch,
          topic: input.topic?.trim() ?? "",
          archived: false,
          createdBy: memberName,
          createdAt: yield* nowIso,
        });
        yield* changed(swarm.swarmId);
        return { result: `Channel #${ch} ready.` };
      }
      if (op === "archive") {
        if (ch === "main") return yield* invalid("Cannot archive #main.");
        yield* store.archiveChannel(swarm.swarmId, ch);
        yield* changed(swarm.swarmId);
        return { result: `Channel #${ch} archived.` };
      }
      const targetName = input.name?.trim().toLowerCase() ?? memberName;
      const target = yield* store.getMember(swarm.swarmId, targetName);
      if (target === null) return yield* notFound(`No swarm member @${targetName}.`);
      const next =
        op === "subscribe"
          ? [...new Set([...target.channels, ch])]
          : target.channels.filter((c) => c !== ch);
      if (!next.includes("main")) next.unshift("main");
      yield* store.updateMemberChannels({
        swarmId: swarm.swarmId,
        name: target.name,
        channels: next,
        primaryChannel: op === "subscribe" ? ch : next[0],
      });
      yield* changed(swarm.swarmId);
      return { result: `@${target.name} channels: ${next.map((c) => `#${c}`).join(", ")}.` };
    }

    if (input.action === "kill") {
      const targetName = input.name?.trim().toLowerCase() ?? "";
      if (!targetName) return yield* invalid("Pass `name` to kill a worker.");
      const members = yield* store.listMembers(swarm.swarmId);
      const targets = members.filter(
        (m) =>
          m.state !== "killed" && (m.name === targetName || m.name.startsWith(`${targetName}-`)),
      );
      if (targets.length === 0) return yield* notFound(`No active swarm member "${targetName}".`);
      for (const m of targets) {
        if (memberName !== "coordinator" && m.addedBy !== memberName) {
          return yield* invalid(
            `@${memberName} may only kill workers it added (@${m.name} was added by @${m.addedBy}).`,
          );
        }
      }
      for (const m of targets) {
        yield* store.updateMemberState({
          swarmId: swarm.swarmId,
          name: m.name,
          state: "killed",
        });
        const targetShell = yield* shellOf(m.threadId).pipe(Effect.orElseSucceed(() => null));
        if (targetShell?.activeRunId) {
          yield* threads
            .dispatch({
              type: "run.interrupt",
              commandId: CommandId.make(`command:swarm-kill:${yield* newId}`),
              threadId: ThreadId.make(m.threadId),
              runId: targetShell.activeRunId,
              reason: "Killed from swarm board",
            })
            .pipe(Effect.ignore);
        }
      }
      yield* changed(swarm.swarmId);
      return { result: `Killed ${targets.map((m) => `@${m.name}`).join(", ")}.` };
    }

    // action === "add"
    const baseName = input.name?.trim().toLowerCase() ?? "";
    const brief = input.brief?.trim() ?? "";
    if (!baseName || !brief) {
      return yield* invalid('`swarm { action: "add" }` requires `name` and `brief`.');
    }
    const callerShell = yield* shellOf(callerThreadId);
    if (callerShell === null) return yield* notFound(`Caller thread ${callerThreadId} is gone.`);

    const slices: Array<{ readonly workerName: string; readonly sliceBrief: string }> = [];
    if (input.tasks && input.tasks.length > 0) {
      input.tasks.forEach((task, i) => {
        slices.push({
          workerName: `${baseName}-${i + 1}`,
          sliceBrief: `Your assigned slice (${i + 1}/${input.tasks!.length}): ${task}\n\n${brief}`,
        });
      });
    } else if (input.n !== undefined && input.n > 1) {
      for (let i = 1; i <= input.n; i++) {
        slices.push({ workerName: `${baseName}-${i}`, sliceBrief: brief });
      }
    } else {
      slices.push({ workerName: baseName, sliceBrief: brief });
    }

    for (const s of slices) {
      if (!WORKER_NAME_RE.test(s.workerName)) {
        return yield* invalid(
          `Invalid worker name "${s.workerName}". Use lowercase letters, digits, '-' or '_' (max 24 chars, not all/coordinator).`,
        );
      }
      if ((yield* store.getMember(swarm.swarmId, s.workerName)) !== null) {
        return yield* conflict(`Swarm member @${s.workerName} already exists.`);
      }
    }

    let rolePreamble: string | undefined;
    let routedModel = input.modelSelection;
    if (input.role !== undefined) {
      const { config, root } = yield* pipelines.configFor(swarm.projectId);
      const role = config.roles.get(input.role);
      if (role === undefined) {
        return yield* invalid(
          `Unknown role "${input.role}". Available: ${[...config.roles.keys()].join(", ")}.`,
        );
      }
      let resolvedRole = role;
      let resolvedTier: string = role.tier;
      if (routedModel === undefined) {
        const providers = yield* pipelines.providers;
        const limited = yield* pipelines.limitedProviders;
        const resolution = resolveRole({
          config,
          role: role.name,
          providers,
          limited,
          escalate: input.escalate,
        });
        if (resolution.ok) {
          routedModel = decodeModelSelection({
            instanceId: ProviderInstanceId.make(resolution.selection.instanceId),
            model: resolution.selection.model,
            ...(resolution.selection.options.length === 0
              ? {}
              : { options: resolution.selection.options }),
          });
          resolvedRole = resolution.role;
          resolvedTier = resolution.tier;
        }
      }
      const effectiveModel = routedModel ?? callerShell.modelSelection;
      const modelFamily =
        detectModelFamily(effectiveModel.model) ?? detectModelFamily(effectiveModel.instanceId);
      const harness = yield* pipelines
        .resolveHarness(resolvedRole, root, {
          skillCatalog: config.skills,
          modelFamily,
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      rolePreamble = renderRoleBrief(resolvedRole, resolvedTier, harness);
    }

    const memberChannels =
      input.channels && input.channels.length > 0
        ? [
            ...new Set([
              "main",
              ...input.channels
                .map((c) => c.trim().replace(/^#/, "").toLowerCase())
                .filter(Boolean),
            ]),
          ]
        : ["main"];
    const primaryChannel = memberChannels.find((c) => c !== "main") ?? "main";
    for (const ch of memberChannels) {
      if (ch !== "main") {
        yield* store.upsertChannel({
          swarmId: swarm.swarmId,
          name: ch,
          topic: "",
          archived: false,
          createdBy: memberName,
          createdAt: yield* nowIso,
        });
      }
    }

    const workspaceMode = input.workspace ?? "inherit";
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      workspaceMode === "worktree"
        ? { type: "worktree", baseRef: callerShell.branch ?? "main" }
        : { type: "root" };

    let forkContextBlock = "";
    if (input.fork !== undefined) {
      const forkName = input.fork.trim().replace(/^@/, "").toLowerCase();
      let sourceThreadId: string | null = null;
      if (forkName === "coordinator") {
        sourceThreadId = swarm.coordinatorThreadId;
      } else {
        const sourceMember = yield* store.getMember(swarm.swarmId, forkName);
        if (sourceMember === null) {
          return yield* notFound(`Cannot fork from unknown swarm member @${forkName}.`);
        }
        sourceThreadId = sourceMember.threadId;
      }
      const records = yield* threads
        .getThreadRecords(ThreadId.make(sourceThreadId), ["messages"])
        .pipe(Effect.orElseSucceed(() => null));
      const recent = (records?.messages ?? [])
        .filter((msg) => msg.text.trim().length > 0)
        .slice(-12)
        .map((msg) => `[${msg.role}] ${msg.text.trim()}`);
      if (recent.length > 0) {
        const joined = recent.join("\n\n");
        const trimmed =
          joined.length > FORK_CONTEXT_CHAR_LIMIT
            ? `…${joined.slice(-FORK_CONTEXT_CHAR_LIMIT)}`
            : joined;
        forkContextBlock = `## Forked Context (from @${forkName})\n${trimmed}\n\n`;
      }
    }

    const spawned: Array<{
      readonly name: string;
      readonly threadId: string;
      readonly seq: number;
    }> = [];
    for (const slice of slices) {
      const id = yield* newId;
      const workerThreadId = ThreadId.make(`swarm-worker-${id}`);
      const at = yield* nowIso;
      const post = yield* store.appendPost({
        swarmId: swarm.swarmId,
        channel: primaryChannel,
        sender: memberName,
        text: `@${slice.workerName} ${slice.sliceBrief}`,
        mentions: [slice.workerName],
        at,
      });
      yield* store.insertMember({
        swarmId: swarm.swarmId,
        name: slice.workerName,
        threadId: workerThreadId,
        role: input.role ?? null,
        workspaceMode,
        channels: memberChannels,
        primaryChannel,
        addedBy: memberName,
        state: "working",
        waitSinceSeq: post.seq,
        mentionsOnly: true,
        createdAt: at,
      });
      yield* launches
        .launch({
          commandId: CommandId.make(`command:swarm-add:${id}`),
          threadId: workerThreadId,
          projectId: callerShell.projectId,
          title: `Swarm: @${slice.workerName}`,
          modelSelection: routedModel ?? callerShell.modelSelection,
          runtimeMode: callContext.runtimeMode,
          interactionMode: callContext.interactionMode,
          workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(`message:swarm-brief:${id}`),
            senderThreadId: ThreadId.make(callerThreadId),
            text: renderSwarmWorkerEnvelope({
              swarmTitle: swarm.title,
              memberName: slice.workerName,
              coordinatorThreadId: swarm.coordinatorThreadId,
              primaryChannel,
              rolePreamble,
              brief: `${forkContextBlock}${slice.sliceBrief}`,
            }),
            attachments: [],
          },
          createdBy: "agent",
          creationSource: "mcp",
          ...(callContext.linkOrigin === undefined ? {} : { linkOrigin: callContext.linkOrigin }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PmError({
                code: "unavailable",
                message: `Could not launch swarm worker @${slice.workerName}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );
      spawned.push({ name: slice.workerName, threadId: workerThreadId, seq: post.seq });
    }
    yield* changed(swarm.swarmId);
    return {
      result: `Added ${spawned.map((s) => `@${s.name} (thread ${s.threadId}, post #${s.seq})`).join(", ")} on workspace=${workspaceMode}.`,
    };
  });

  const getBoardForThread = Effect.fn("SwarmService.getBoardForThread")(function* (
    threadId: string,
  ): Effect.fn.Return<SwarmBoardSnapshot | null, PmError> {
    const ctx = yield* store.findSwarmForThread(threadId);
    if (ctx === null) return null;
    const members = yield* store.listMembers(ctx.swarm.swarmId);
    const channels = yield* store.listChannels(ctx.swarm.swarmId);
    const posts = yield* store.listPosts({ swarmId: ctx.swarm.swarmId, since: 0, limit: 300 });
    return {
      swarm: ctx.swarm,
      members,
      channels,
      posts,
      viewerRole: ctx.member === null ? "coordinator" : "member",
      viewerName: ctx.memberName,
    };
  });

  const postFromUser = Effect.fn("SwarmService.postFromUser")(function* (
    threadId: string,
    text: string,
    channel?: string,
  ) {
    const ctx = yield* store.findSwarmForThread(threadId);
    if (ctx === null) return yield* notFound("No active swarm on this thread.");
    const at = yield* nowIso;
    const targetChannel = (channel ?? "main").trim().toLowerCase() || "main";
    const mentions = parseMentions(text);
    const post = yield* store.appendPost({
      swarmId: ctx.swarm.swarmId,
      channel: targetChannel,
      sender: "user",
      text: text.trim(),
      mentions,
      at,
    });
    const members = yield* store.listMembers(ctx.swarm.swarmId);
    yield* deliverBoardWakeups({ swarm: ctx.swarm, post, members });
    yield* changed(ctx.swarm.swarmId);
    return post;
  });

  const syncMemberOnThreadShell = Effect.fn("SwarmService.syncMemberOnThreadShell")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const member = yield* store.getMemberByThread(shell.id).pipe(Effect.orElseSucceed(() => null));
    if (member === null || member.state === "killed") return;
    let nextState: SwarmMemberState = member.state;
    if (RUNNING_STATUSES.has(shell.status)) nextState = "working";
    else if (STOPPED_STATUSES.has(shell.status)) nextState = "stopped";
    else nextState = "waiting";
    if (nextState !== member.state) {
      yield* store
        .updateMemberState({ swarmId: member.swarmId, name: member.name, state: nextState })
        .pipe(Effect.ignore);
      yield* changed(member.swarmId);
    }
  });

  const stallNudges = new Set<string>();

  /** Built-in stall monitor: wakes quiet working members or a stalled coordinator after 8 minutes. */
  const checkStalls = Effect.fn("SwarmService.checkStalls")(function* () {
    const activeSwarms = yield* store.listActiveSwarms().pipe(Effect.orElseSucceed(() => []));
    if (activeSwarms.length === 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));

    for (const swarm of activeSwarms) {
      const members = yield* store.listMembers(swarm.swarmId).pipe(Effect.orElseSucceed(() => []));
      const alive = members.filter((m) => m.state !== "killed");
      if (alive.length === 0) continue;

      const working = alive.filter((m) => m.state === "working");
      if (working.length > 0) {
        for (const member of working) {
          const shell = yield* threads
            .getThreadShell(ThreadId.make(member.threadId))
            .pipe(Effect.orElseSucceed(() => null));
          if (shell === null) continue;
          const lastActivityMs = Math.max(
            DateTime.toEpochMillis(shell.updatedAt),
            shell.activityRunStartedAt ? DateTime.toEpochMillis(shell.activityRunStartedAt) : 0,
          );
          if (nowMs - lastActivityMs < SWARM_STALL_AFTER_MS) continue;
          const streakKey = `${swarm.swarmId}:${member.name}@${lastActivityMs}`;
          if (stallNudges.has(streakKey)) continue;
          stallNudges.add(streakKey);
          const post = yield* store
            .appendPost({
              swarmId: swarm.swarmId,
              channel: "main",
              sender: "monitor",
              text: `@${member.name} [stall] No activity for 8+ minutes; report progress, hand off, or call swarm_wait.`,
              mentions: [member.name],
              at,
            })
            .pipe(Effect.orElseSucceed(() => null));
          if (post !== null) {
            yield* deliverBoardWakeups({ swarm, post, members }).pipe(Effect.ignore);
            yield* changed(swarm.swarmId);
          }
        }
        continue;
      }

      const posts = yield* store
        .listPosts({ swarmId: swarm.swarmId, since: Math.max(0, swarm.nextSeq - 2), limit: 5 })
        .pipe(Effect.orElseSucceed(() => []));
      const latest = posts.at(-1);
      if (!latest) continue;
      if (latest.sender === "monitor" || latest.text.includes("[done]")) continue;
      const latestMs = Date.parse(latest.createdAt);
      if (!Number.isFinite(latestMs) || nowMs - latestMs < SWARM_STALL_AFTER_MS) continue;
      const streakKey = `${swarm.swarmId}:coordinator@${latest.seq}`;
      if (stallNudges.has(streakKey)) continue;
      stallNudges.add(streakKey);
      const post = yield* store
        .appendPost({
          swarmId: swarm.swarmId,
          channel: "main",
          sender: "monitor",
          text: `@coordinator [stall] All workers are waiting and no post since #${latest.seq}; assign the next step or mark the swarm done.`,
          mentions: ["coordinator"],
          at,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (post !== null) {
        yield* deliverBoardWakeups({ swarm, post, members }).pipe(Effect.ignore);
        yield* changed(swarm.swarmId);
      }
    }
  });

  return {
    swarmAction,
    postMessage,
    readBoard,
    swarmWait,
    getBoardForThread,
    postFromUser,
    syncMemberOnThreadShell,
    checkStalls,
    changes: Stream.fromPubSub(changes),
  };
});

export class SwarmService extends Context.Service<SwarmService, Effect.Success<typeof make>>()(
  "t3/swarm/SwarmService",
) {}

export const layer = Layer.effect(SwarmService, make);

export const layerWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const swarm = yield* SwarmService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type !== "run.updated") {
          return Effect.void;
        }
        return threads.getThreadShell(event.threadId).pipe(
          Effect.flatMap((shell) => (shell ? swarm.syncMemberOnThreadShell(shell) : Effect.void)),
          Effect.ignore({ log: true }),
        );
      }),
    );
    yield* scheduler.register("swarm-stall-monitor", swarm.checkStalls().pipe(Effect.ignore));
  }),
);
