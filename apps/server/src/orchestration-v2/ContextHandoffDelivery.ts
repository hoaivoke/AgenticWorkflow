import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

// A first word with a second slash is a path, not a command.
const SLASH_COMMAND = /^\s*\/[^\s/]+(?:\s|$)/u;
const SWARM_COMMAND = /^\s*\/swarm(?:\s+([\s\S]*))?$/iu;
const SWARM_PIPELINE_FLAG = /^--pipeline(?:=|\s+)([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/iu;
// `/swarm --scorched-earth [goal]` is shorthand for `/swarm --pipeline scorched-earth [goal]`.
const SWARM_SCORCHED_EARTH_FLAG = /^--scorched-earth(?:\s+([\s\S]*))?$/iu;
const SCORCHED_EARTH_PIPELINE = "scorched-earth";
const SCORCHED_EARTH_RULE =
  "  6. Scorched Earth loop: builders must emit `surface-inventory.json`; run zero-cost `pm_verify_app` / `pm_run_gates` first; feed both `surface-inventory.json` and the actual `git diff` to `scenario-generator` across seeded states (`empty`, `in-progress`, `completed`, `error/limited`); playtest with `playtester`; cap Troubleshooter -> Fixer -> Playtester retries at 3 cycles (escalate the tier on retry 2, stop and ask the user on retry 3).";

const parseSwarmArgs = (
  rawArgs: string,
): { readonly pipelineName: string | null; readonly goal: string } => {
  const scorched = SWARM_SCORCHED_EARTH_FLAG.exec(rawArgs);
  if (scorched) return { pipelineName: SCORCHED_EARTH_PIPELINE, goal: (scorched[1] ?? "").trim() };
  const pipelineMatch = SWARM_PIPELINE_FLAG.exec(rawArgs);
  if (pipelineMatch) {
    return {
      pipelineName: pipelineMatch[1]?.trim() ?? null,
      goal: (pipelineMatch[2] ?? "").trim(),
    };
  }
  return { pipelineName: null, goal: rawArgs };
};

export function expandSwarmCommandText(text: string): string | null {
  const match = SWARM_COMMAND.exec(text.trim());
  if (!match) return null;
  const { pipelineName, goal } = parseSwarmArgs((match[1] ?? "").trim());

  if (pipelineName !== null) {
    const objective =
      goal.length > 0
        ? goal
        : `Execute the "${pipelineName}" pipeline in Swarm mode for this repository.`;
    return [
      `[Swarm Mode Coordinator Brief: Pipeline ${pipelineName}]`,
      `You are coordinating a pipeline-backed multi-agent Swarm in this thread using the customizable "${pipelineName}" pipeline.`,
      "- Swarm tools: `swarm` (actions: `pipeline`, `model`, `title`, `status`, `models`, `add`, `channel`, `kill`, `done`), `post_message`, `read_board`, `swarm_wait`, plus `pm_pipelines` / `pm_roles` / `pm_run_gates` when available. If using deferred tool discovery, call `tool_search` with `swarm` first.",
      "- Workflow:",
      `  1. Immediately call \`swarm(action: "pipeline", pipeline: "${pipelineName}"${goal.length > 0 ? `, goal: ${JSON.stringify(goal)}` : ""})\` to bind the pipeline, post its stage blueprint to #main, and inspect every stage's role, workspace, parallel/provider constraints, and Big-3 model-family skills.`,
      '  2. Execute the pipeline stages in order by spawning role-routed workers with `swarm(action: "add", name, role, brief, workspace: "worktree" | "inherit", tasks?, n?)`. Always pass the stage\'s `role` so tier routing picks an available model across vendors and automatically injects the role\'s matched skills & Big-3 family guidance. Honor each stage\'s `workspace`, `parallel`, and `differentProviderFrom` requirements.',
      '  3. If any worker hits a usage limit or needs tier escalation, call `swarm(action: "model", name, escalate?)` to hot-switch its model without killing its conversation.',
      "  4. Coordinate on `#main` with `post_message` (`@<name>`, `@all`, `@#<channel>`), refer to prior messages by `#seq`, and call `swarm_wait(since)` before ending your turn when waiting for workers.",
      '  5. Run `pm_run_gates` (or verify directly) before calling `swarm(action: "done")` and reporting the final result.',
      ...(pipelineName === SCORCHED_EARTH_PIPELINE ? [SCORCHED_EARTH_RULE] : []),
      "",
      "User goal:",
      objective,
    ].join("\n");
  }

  const objective =
    goal.length > 0
      ? goal
      : "Coordinate and execute this task in Swarm mode. Clarify or decompose into specialized worker roles now.";
  return [
    "[Swarm Mode Coordinator Brief]",
    "You are coordinating a multi-agent Swarm in this thread using the Swarm board tools.",
    "- Swarm tools: `swarm` (actions: `title`, `status`, `models`, `pipeline`, `model`, `add`, `channel`, `kill`, `done`), `post_message`, `read_board`, `swarm_wait`, plus `pm_pipelines` / `pm_roles` / `pm_run_gates` when available. If using deferred tool discovery, call `tool_search` with `swarm` first.",
    "- Workflow:",
    '  1. Set a concise swarm `title` (or bind a customizable workflow with `swarm(action: "pipeline", pipeline)`), inspect `swarm(action: "models")`, and spawn specialized workers with `swarm(action: "add", name, role, brief, workspace: "worktree" | "inherit", tasks?, n?)`. Always pass `role` (tier system: small = haiku/hydrogen/terra for light/brute work; mid = sonnet/sol/neon for standard build/review; frontier = opus/fable/astra/carbon/neon for heavy-duty work) instead of pinning one vendor so workers automatically get matched skills & fail over to another provider with available usage instead of halting. Use `workspace: "worktree"` for parallel writers editing files; keep readers/reviewers/verifiers on `inherit`.',
    '  2. If a worker hits a usage limit or needs escalation, call `swarm(action: "model", name, escalate?)` to hot-switch its model without killing its conversation.',
    "  3. Coordinate on the shared message board with `post_message` (`@<name>`, `@all`, `@#<channel>`) and refer to prior messages by `#seq` rather than repeating them.",
    "  4. When waiting for workers to finish or report, call `swarm_wait(since)` right before ending your turn to park at zero token cost and auto-wake on `@coordinator` mentions.",
    '  5. Run `pm_run_gates` (or verify directly) before calling `swarm(action: "done")` and reporting the final result.',
    '  5. If you (the Swarm coordinator) are running on a standard Gemini model (such as `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-argon`, or `gemini-4-hydrogen`) and an Orchestrator variant of that model is listed by `swarm(action: "models")` (such as `gemini-pro-orchestrator-neon` or `gemini-pro-orchestrator`), ask the user once if they want to switch this coordinator thread to the Orchestrator variant of that model instead.',
    "",
    "User goal:",
    objective,
  ].join("\n");
}

/** Providers only run a native command that opens the prompt, so its turn defers inline context to the next one. */
export const isSlashCommandMessage = (message: {
  readonly role: string;
  readonly text: string;
}): boolean =>
  message.role === "user" &&
  SLASH_COMMAND.test(message.text) &&
  expandSwarmCommandText(message.text) === null;

/** The provider prompt for a turn that carries inline context ahead of the user's text. */
export const withInlineContext = (context: string, userText: string): string =>
  context === "" ? userText : `${context}\n\nUser message:\n${userText}`;

/** Persist around injection; ambiguous delivery requires a fresh native thread. Call unsent if refused before prompt consumption. */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity, afterPosition=-1; paginate with afterPosition=nextPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover an omitted item only when the request needs it, with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",itemId:"<omitted item ID>",maxCharsPerItem:4000}); continue long text with textOffset=nextTextOffset until null. Follow fork/handoff source references in activity. Items included below need no read.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
      omittedItemIds: pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline)
        return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
      return yield* new ContextHandoffBudgetError();
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction cannot carry inline transcripts; retain for the next turn if native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      unsent: Effect.forEach(pending, input.persist, { discard: true }),
      inlineHandoffs: pending,
    };
  },
);

export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
