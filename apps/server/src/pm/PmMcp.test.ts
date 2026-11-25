import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { PM_PAGE_GUIDE, PM_PLAYBOOK } from "@t3tools/pm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { advertisedJsonSchema } from "../mcp/advertisedJsonSchema.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  ASK_DETAIL,
  layerPm,
  layerPmRemoteHere,
  makeWorld,
  messagesTo,
  PROJECT,
  shellFor,
  type PmWorld,
} from "./Pm.testkit.ts";
import * as PmMcpHandlers from "./PmMcpHandlers.ts";
import { PmToolkit } from "./PmMcpTools.ts";
import { PmService } from "./PmService.ts";
import { PmStore } from "./PmStore.ts";
import { hiddenUnlessPeerLink, hiddenUnlessPm, hiddenUnlessPmWorker } from "./PmVisibility.ts";

const scopeFor = (threadId: string) => ({
  environmentId: EnvironmentId.make("environment:pm"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

type ToolName = keyof typeof PmToolkit.tools;

const harness = (world: PmWorld) =>
  McpToolAccess.HandlersLayer.layer(PmMcpHandlers.layer).pipe(
    Layer.provideMerge(layerPmRemoteHere),
    Layer.provideMerge(layerPm(world)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

/** Calls one tool as `threadId`; returns the success value or the returned failure. */
const callAs = Effect.fn("test.callAs")(function* (
  threadId: string,
  name: ToolName,
  params: Record<string, unknown>,
) {
  const toolkit = yield* PmToolkit;
  const parts = yield* toolkit
    .handle(name as never, params as never)
    .pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
    );
  return parts.at(-1)?.result as unknown as {
    result?: string;
    notes?: ReadonlyArray<string>;
    code?: string;
    message?: string;
  };
});

const createPm = (world: PmWorld) =>
  Effect.gen(function* () {
    const service = yield* PmService;
    const { threadId } = yield* service.create({
      projectId: PROJECT,
      createdBy: "user",
      creationSource: "web",
    });
    // Tools are called during the PM's own turn.
    const shell = world.shells.get(threadId)!;
    world.shells.set(threadId, {
      ...shell,
      status: "running",
      activeRunId: RunId.make(`run:${threadId}`),
    });
    // The setup turn reads the guide, as the playbook asks.
    yield* callAs(threadId, "pm_guide", {});
    world.commands.length = 0;
    return threadId;
  });

describe("pm_* tool schemas", () => {
  it("every tool advertises an object input schema, as MCP clients require", () => {
    for (const tool of Object.values(PmToolkit.tools))
      expect(advertisedJsonSchema(tool), tool.name).toMatchObject({ type: "object" });
  });
});

describe("pm_* tool visibility", () => {
  it.effect("only PM threads see the tools, and only while the switch is on", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const visibleTo = (threadId: string) =>
        Effect.sync(hiddenUnlessPm).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
        );
      assert.isTrue(yield* visibleTo(pm));
      assert.isFalse(yield* visibleTo("thread-plain"));
      const service = yield* PmService;
      yield* service.setSettings({ enabled: false });
      assert.isFalse(yield* visibleTo(pm));
      // Off refuses calls too, not only discovery.
      expect(yield* callAs(pm, "pm_status", {})).toMatchObject({ code: "capability_denied" });
      yield* service.setSettings({ enabled: true });
      assert.isTrue(yield* visibleTo(pm));
      world.shells.set("thread-plain", shellFor("thread-plain"));
      expect(yield* callAs("thread-plain", "pm_status", {})).toMatchObject({
        code: "invalid_request",
        message: "Thread thread-plain is not a project manager.",
      });

      // pm_host_status: only another computer's peer link, never a thread or a plain client.
      const hostStatusVisibleTo = (scope: McpInvocationContext.McpInvocationScope) =>
        Effect.sync(hiddenUnlessPeerLink).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        );
      const client = (linked: boolean): McpInvocationContext.McpInvocationScope => ({
        ...scopeFor(pm),
        thread: undefined,
        client: { sessionId: "session", label: "Mac mini", access: "auto", linked },
      });
      assert.isTrue(yield* hostStatusVisibleTo(client(true)));
      assert.isFalse(yield* hostStatusVisibleTo(client(false)));
      assert.isFalse(yield* hostStatusVisibleTo(scopeFor(pm)));
      yield* service.setSettings({ enabled: false });
      assert.isFalse(yield* hostStatusVisibleTo(client(true)));
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("pm_* tools", () => {
  it.effect("guide, overrides and the changed-playbook note", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const guide = yield* callAs(pm, "pm_guide", {});
      assert.strictEqual(guide.result, PM_PLAYBOOK);
      assert.isUndefined(guide.notes);
      // The page guide is read on demand and never counts as a playbook read.
      assert.strictEqual((yield* callAs(pm, "pm_guide", { pages: true })).result, PM_PAGE_GUIDE);
      expect(
        (yield* callAs(pm, "pm_playbook_override", {
          op: "add",
          text: "Always ask before a release.",
        })).result,
      ).toBe("1. Always ask before a release.");
      const status = yield* callAs(pm, "pm_status", {});
      expect(status.notes).toContain("Your playbook changed: call pm_guide with changes: true.");
      const changes = yield* callAs(pm, "pm_guide", { changes: true });
      expect(changes.result).toContain("1. Always ask before a release.");
      expect(changes.result).not.toContain("Facilitator");
      expect((yield* callAs(pm, "pm_guide", { changes: true })).result).toBe(
        "Nothing changed since your last read.",
      );
      expect(
        yield* callAs(pm, "pm_playbook_override", { op: "replace", number: 3, text: "x" }),
      ).toMatchObject({ code: "invalid_request", message: "There is no override 3." });
      expect((yield* callAs(pm, "pm_playbook_override", { op: "remove", number: 1 })).result).toBe(
        "No playbook overrides.",
      );
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("name, mission, instructions and memory", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      expect((yield* callAs(pm, "pm_set_name", { name: "Mobile launch" })).result).toBe(
        'Renamed to "Mobile launch".',
      );
      expect(world.commands.at(-1)).toMatchObject({
        type: "thread.metadata.update",
        title: "Mobile launch",
      });
      yield* callAs(pm, "pm_set_mission", { mission: "Ship the app." });
      yield* callAs(pm, "pm_set_instructions", { instructions: "No pushes." });
      expect((yield* callAs(pm, "pm_remember", { text: "Use pnpm." })).result).toBe(
        "Saved as memory note 1.",
      );
      yield* callAs(pm, "pm_remember", { text: "Tests first." });
      expect((yield* callAs(pm, "pm_forget", { number: 1 })).result).toContain("moved up");
      expect(yield* callAs(pm, "pm_forget", { number: 9 })).toMatchObject({
        code: "invalid_request",
      });
      const status = (yield* callAs(pm, "pm_status", {})).result ?? "";
      expect(status).toContain("Name: Mobile launch");
      expect(status).toContain("Mission: Ship the app.");
      expect(status).toContain("Standing instructions: No pushes.");
      expect(status).toContain("1. Tests first.");
      // The PM's own edits are not echoed back to it as messages.
      assert.lengthOf(messagesTo(world, pm), 0);
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("work items: add, now, steps, waits, done, drop, later and restore", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      expect((yield* callAs(pm, "pm_item_add", { title: "Checkout redesign" })).result).toBe(
        'Added W1 "Checkout redesign".',
      );
      yield* callAs(pm, "pm_item_add", { title: "Release notes" });
      expect(
        yield* callAs(pm, "pm_item_update", {
          item: "W1",
          now: "Waiting on your try of the build",
        }),
      ).toMatchObject({ code: "invalid_request" });
      expect(
        (yield* callAs(pm, "pm_item_update", {
          item: "W1",
          now: "Worker is on the layout",
          step: "Layout",
        })).result,
      ).toBe("W1: now line set, step 1 added.");
      expect((yield* callAs(pm, "pm_item_update", { item: 1, step_done: 1 })).result).toBe(
        "W1: step 1 done.",
      );
      expect((yield* callAs(pm, "pm_item_update", { item: "W2", wait: "W1" })).result).toBe(
        "W2: wait set.",
      );
      expect(yield* callAs(pm, "pm_item_update", { item: "W1", status: "done" })).toMatchObject({
        code: "invalid_request",
        message: "Pass `done` with the one line worth keeping.",
      });
      yield* callAs(pm, "pm_item_update", { item: "W1", status: "done", done: "Shipped in 1.2" });
      const list = (yield* callAs(pm, "pm_item_list", {})).result ?? "";
      expect(list).toContain("W1 Checkout redesign: Done");
      // W2's wait on W1 cleared when W1 finished.
      expect(list).toContain("W2 Release notes: In progress");
      // In progress only because the PM touched it this turn: nobody's once the turn ends.
      const check = (yield* callAs(pm, "pm_item_list", { check: true })).result ?? "";
      expect(check).toContain("Turn check: 1 to fix before you end your turn:");
      expect(check).toContain("In progress on you, no worker on it");
      expect(check).toContain("    W2 Release notes\n");
      expect(check).not.toContain("W1");
      yield* callAs(pm, "pm_item_update", { item: "W2", status: "later", reason: "After launch" });
      expect((yield* callAs(pm, "pm_item_list", {})).result).toContain("W2 Release notes: Later");
      expect((yield* callAs(pm, "pm_item_list", { check: true })).result).toBe(
        "Turn check: all clear. nothing in progress.",
      );
      yield* callAs(pm, "pm_item_update", { item: "W2", status: "drop" });
      expect((yield* callAs(pm, "pm_item_list", {})).result).not.toContain("W2");
      yield* callAs(pm, "pm_item_update", { item: "W2", status: "restore" });
      expect((yield* callAs(pm, "pm_item_add", { title: "Third" })).result).toBe(
        'Added W3 "Third".',
      );
      expect(yield* callAs(pm, "pm_item_update", { item: "W9", now: "x" })).toMatchObject({
        message: "There is no W9.",
      });
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("asks: Q tags count up and are never reused; done, withdraw and a holding ask", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      yield* callAs(pm, "pm_item_add", { title: "Launch" });
      expect(
        yield* callAs(pm, "pm_ask", { item: "W1", title: "Ship Q3 build?", detail: ASK_DETAIL }),
      ).toMatchObject({ message: expect.stringContaining("internal references (Q3)") });
      expect(
        yield* callAs(pm, "pm_ask", { item: "W1", title: "Ship W1 today?", detail: "x" }),
      ).toMatchObject({
        message: expect.stringMatching(
          /^This question cannot be asked yet:\n- The title contains internal references \(W1\).*Matching work items: W1 \("Launch"\)\.\n- Description is too short \(1 characters/,
        ),
      });
      expect(
        yield* callAs(pm, "pm_ask", {
          title: "Pick the icon on the Live page",
          detail: ASK_DETAIL,
        }),
      ).toMatchObject({
        message: expect.stringContaining('points at a Live page (matched "on the live page")'),
      });
      expect(
        yield* callAs(pm, "pm_ask", { title: "Post the release notes", detail: ASK_DETAIL }),
      ).toMatchObject({ message: expect.stringContaining('"Post …" asks the user to act') });
      expect(
        (yield* callAs(pm, "pm_ask", {
          item: "W1",
          title: "Ship the iPhone build today?",
          detail: ASK_DETAIL,
          answers: "Yes*,No",
          holds: true,
        })).result,
      ).toContain("Asked W1 Q1");
      expect((yield* callAs(pm, "pm_item_list", {})).result).toContain("W1 Launch: Blocked");
      expect((yield* callAs(pm, "pm_ask_withdraw", { tag: "Q1" })).result).toBe("Q1 withdrawn.");
      expect(yield* callAs(pm, "pm_ask_withdraw", { tag: "Q1" })).toMatchObject({
        message: "Q1 is already withdrawn.",
      });
      yield* callAs(pm, "pm_item_update", { item: "W1", status: "drop" });
      expect((yield* callAs(pm, "pm_next_tag", {})).result).toBe(
        "Reserved Q2 for your next question; the next work item is W2.",
      );
      // The reserved tag is never handed out again.
      expect(
        (yield* callAs(pm, "pm_ask", { title: "Use the old icon?", detail: ASK_DETAIL })).result,
      ).toContain("Asked Q3");
      expect((yield* callAs(pm, "pm_ask_done", { tag: 3 })).result).toBe("Q3 closed as done.");
      const store = yield* PmStore;
      assert.deepStrictEqual(
        (yield* store.listAsks(pm)).map((ask) => [ask.askNo, ask.state]),
        [
          [1, "withdrawn"],
          [3, "done"],
        ],
      );
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("workers: start with a brief footer, link, unlink, resolve and their refusals", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      yield* callAs(pm, "pm_set_mission", { mission: "Ship the app." });
      yield* callAs(pm, "pm_item_add", { title: "Pairing" });
      const started = yield* callAs(pm, "pm_worker_start", {
        title: "Fix pairing screen",
        brief: "Fix the pairing screen layout.",
        item: "W1",
      });
      expect(started.result).toContain('Started worker "Fix pairing screen"');
      const launch = world.launches.at(-1);
      expect(launch?.initialMessage?.text).toContain("Fix the pairing screen layout.");
      expect(launch?.initialMessage?.text).toContain("Its mission: Ship the app.");
      expect(launch?.initialMessage?.text).toContain("Never message the project manager's thread");
      expect(launch?.initialMessage?.text).toContain("Right after every push, send a short note");
      assert.strictEqual(launch?.initialMessage?.senderThreadId, pm);
      expect((yield* callAs(pm, "pm_item_list", {})).result).toContain("W1 Pairing: In progress");

      world.failLaunch = true;
      expect(
        yield* callAs(pm, "pm_worker_start", { title: "Broken", brief: "Nothing." }),
      ).toMatchObject({ code: "orchestration_error" });
      world.failLaunch = false;
      const store = yield* PmStore;
      assert.lengthOf(yield* store.listWorkers(pm), 1);

      world.shells.set(
        "thread-user",
        shellFor("thread-user", { projectId: PROJECT, title: "User thread" }),
      );
      world.shells.set(
        "thread-other",
        shellFor("thread-other", { projectId: "project:other" as typeof PROJECT }),
      );
      expect((yield* callAs(pm, "pm_worker_link", { thread: "thread-user" })).result).toContain(
        'Linked "User thread"',
      );
      expect(yield* callAs(pm, "pm_worker_link", { thread: "thread-other" })).toMatchObject({
        message: "Thread thread-other is in another project.",
      });
      expect(yield* callAs(pm, "pm_worker_link", { thread: pm })).toMatchObject({
        message: "A PM cannot be its own worker.",
      });
      expect((yield* callAs(pm, "pm_worker_resolve", { thread: "thread-user" })).result).toContain(
        "no more reports",
      );
      expect((yield* callAs(pm, "pm_worker_unlink", { thread: "thread-user" })).result).toContain(
        "ordinary thread again",
      );
      expect(yield* callAs(pm, "pm_worker_unlink", { thread: "thread-user" })).toMatchObject({
        message: "Thread thread-user is not your worker.",
      });
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("a worker's push note reaches its PM and pm_status; only workers see the tool", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      yield* callAs(pm, "pm_worker_start", { title: "Fix pairing", brief: "Fix it." });
      const worker = world.launches.at(-1)!.threadId!;
      world.shells.set(
        worker,
        shellFor(worker, {
          projectId: PROJECT,
          title: "Fix pairing",
          status: "running",
          activeRunId: RunId.make(`run:${worker}`),
        }),
      );
      const visibleTo = (threadId: string) =>
        Effect.sync(hiddenUnlessPmWorker).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
        );
      assert.isTrue(yield* visibleTo(worker));
      assert.isFalse(yield* visibleTo(pm));
      assert.isFalse(yield* visibleTo("thread-plain"));

      expect(yield* callAs(worker, "pm_worker_note", { note: " " })).toMatchObject({
        message: 'Give a short one-line note (e.g. "<commit> <what landed>").',
      });
      expect(yield* callAs(worker, "pm_worker_note", { note: "x".repeat(601) })).toMatchObject({
        message: "Keep the note to one line under 600 characters.",
      });
      expect(
        (yield* callAs(worker, "pm_worker_note", { note: "abc1234 pairing\n  fix landed" })).result,
      ).toBe("Sent note to the project manager: abc1234 pairing fix landed");
      const sent = messagesTo(world, pm).at(-1);
      expect(sent?.text).toBe(
        `Worker note from "Fix pairing" (thread ${worker}): abc1234 pairing fix landed`,
      );
      assert.strictEqual(sent?.senderThreadId, worker);
      expect((yield* callAs(pm, "pm_status", {})).result).toContain(": abc1234 pairing fix landed");
      world.shells.set(
        "thread-plain",
        shellFor("thread-plain", { status: "running", activeRunId: RunId.make("run:plain") }),
      );
      expect(yield* callAs("thread-plain", "pm_worker_note", { note: "x" })).toMatchObject({
        message: "This thread is not a project manager's worker, so pm_worker_note does not apply.",
      });
      yield* callAs(pm, "pm_worker_resolve", { thread: worker });
      expect(yield* callAs(worker, "pm_worker_note", { note: "late" })).toMatchObject({
        message: "This worker is already resolved, so its note was not sent.",
      });
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("links and Live pages", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      yield* callAs(pm, "pm_item_add", { title: "Launch" });
      expect(
        (yield* callAs(pm, "pm_link_add", { item: "W1", url: "https://github.com/o/r/pull/12" }))
          .result,
      ).toBe("Linked the PR https://github.com/o/r/pull/12.");
      expect(yield* callAs(pm, "pm_link_add", { url: "o/r#12" })).toMatchObject({
        code: "invalid_request",
      });
      const first = yield* callAs(pm, "pm_page_show", {
        html: "<p>Pick one</p>",
        title: "Icon options",
        source_name: "icons.html",
        question_tags: ["Q1"],
      });
      expect(first.result).toContain("asking Q1");
      // A page's tag counts as used, and pm_next_tag reserves the next one for another page.
      expect((yield* callAs(pm, "pm_next_tag", {})).result).toBe(
        "Reserved Q2 for your next question; the next work item is W2.",
      );
      expect(
        yield* callAs(pm, "pm_page_show", {
          html: "<p>Again</p>",
          title: "Icons",
          source_name: "other.html",
          question_tags: ["Q1"],
        }),
      ).toMatchObject({
        code: "invalid_request",
        message:
          "This page's question tag is already taken: Q1 is asked on another page. A tag means one question, and an answer on the page would settle that one. Give the page's question a new tag (Q3 is free; pm_next_tag reserves one) and publish it again.",
      });
      yield* callAs(pm, "pm_ask", { item: "W1", title: "Ship the new icon?", detail: ASK_DETAIL });
      expect(
        yield* callAs(pm, "pm_page_show", {
          html: "<p>Q3</p>",
          title: "Icons",
          source_name: "other.html",
          question_tags: ["Q3"],
        }),
      ).toMatchObject({
        message: expect.stringContaining(
          'already taken: Q3 is W1\'s question "Ship the new icon?".',
        ),
      });
      const seven = ["A", "B", "C", "D", "E", "F", "G"].map((c) => `<gx-choice>${c}</gx-choice>`);
      const reserved = yield* callAs(pm, "pm_page_show", {
        html: `<gx-question tag="Q2" title="Which look?">${seven.join("")}</gx-question>`,
        title: "Icon looks",
        source_name: "looks.html",
        question_tags: ["Q2"],
      });
      expect(reserved.result).toContain("asking Q2");
      expect(reserved.result).toContain('Choices:\nWarning: Q2 ("Which look?"): it has 7 pick-one');
      yield* callAs(pm, "pm_page_show", {
        html: "<p>v2</p>",
        title: "Icon options",
        source_name: "icons.html",
      });
      const store = yield* PmStore;
      const pages = yield* store.listPages(pm);
      assert.deepStrictEqual(pages.map((page) => page.state).toSorted(), [
        "open",
        "open",
        "replaced",
      ]);
      const open = pages.find((page) => page.sourceName === "icons.html" && page.state === "open")!;
      assert.strictEqual(open.html, "<p>v2</p>");
      const retired = yield* callAs(pm, "pm_page_retire", { page: open.pageId });
      expect(retired.result).toContain("Retired page");
      expect(yield* callAs(pm, "pm_page_retire", { page: "page-missing" })).toMatchObject({
        message: "There is no page page-missing.",
      });
    }).pipe(Effect.provide(harness(world)));
  });
});
