import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerPm, makeWorld, messagesTo, PROJECT, type PmWorld } from "./Pm.testkit.ts";
import { PmService } from "./PmService.ts";
import { PAGE_ANSWERS_LIMIT, PM_NEW_TITLE } from "./PmText.ts";

const harness = (world: PmWorld) =>
  layerPm(world).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const createPm = (world: PmWorld) =>
  Effect.gen(function* () {
    const service = yield* PmService;
    const { threadId } = yield* service.create({
      projectId: PROJECT,
      createdBy: "user",
      creationSource: "web",
    });
    const shell = world.shells.get(threadId)!;
    world.shells.set(threadId, {
      ...shell,
      status: "running",
      activeRunId: RunId.make(`run:${threadId}`),
    });
    yield* service.guide(threadId, false);
    world.commands.length = 0;
    return threadId;
  });

const withAsk = (pm: string, holds = false) =>
  Effect.gen(function* () {
    const service = yield* PmService;
    yield* service.itemAdd(pm, { title: "Launch" });
    yield* service.ask(pm, {
      item: "W1",
      title: "Ship the iPhone build today?",
      detail: "CI is green.",
      answers: "Yes*,No",
      holds,
    });
  });

describe("PmService.create", () => {
  it.effect("names the thread before its first message and remembers the model", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const { threadId } = yield* service.create({
        projectId: PROJECT,
        createdBy: "user",
        creationSource: "web",
      });
      const launch = world.launches[0]!;
      assert.strictEqual(launch.title, PM_NEW_TITLE);
      assert.strictEqual(launch.generateTitle, false);
      assert.isUndefined(launch.initialMessage);
      assert.strictEqual(launch.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
      // A deliberate title lands before any message, so upstream never queues a title generation
      // that would later overwrite the PM's own name.
      assert.deepStrictEqual(
        world.commands.map((command) => command.type),
        ["thread.metadata.update", "message.dispatch"],
      );
      expect(world.commands[1]).toMatchObject({
        threadId,
        createdBy: "agent",
        notification: { source: { kind: "system" }, summary: "Project manager setup" },
      });
      const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* service.create({
        projectId: PROJECT,
        modelSelection: model,
        createdBy: "user",
        creationSource: "web",
      });
      yield* service.create({ projectId: PROJECT, createdBy: "user", creationSource: "web" });
      expect(world.launches[2]!.modelSelection).toMatchObject(model);
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("a failed launch leaves no PM behind", () => {
    const world = makeWorld();
    world.failLaunch = true;
    return Effect.gen(function* () {
      const service = yield* PmService;
      const exit = yield* Effect.exit(
        service.create({ projectId: PROJECT, createdBy: "user", creationSource: "web" }),
      );
      assert.isTrue(exit._tag === "Failure");
      assert.deepStrictEqual((yield* service.summaries()).pms, []);
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("asks from the dock", () => {
  it.effect("an answer is recorded and sent once as `W1 Q1: …`; a second answer is refused", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* withAsk(pm);
      yield* service.answerAsk(pm, 1, "Yes");
      const sent = messagesTo(world, pm);
      assert.lengthOf(sent, 1);
      expect(sent[0]).toMatchObject({ text: "W1 Q1: Yes", createdBy: "user" });
      const second = yield* Effect.flip(service.answerAsk(pm, 1, "No"));
      assert.strictEqual(second.code, "conflict");
      assert.lengthOf(messagesTo(world, pm), 1);
      const detail = (yield* service.detail(pm))!;
      expect(detail.asks[0]).toMatchObject({
        state: "answered",
        answer: "Yes",
        answerMessageId: sent[0]!.messageId,
      });
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("a dismiss sends nothing, then shows once in the PM's next tool result", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* withAsk(pm);
      yield* service.dismissAsk(pm, 1);
      assert.lengthOf(messagesTo(world, pm), 0);
      const next = yield* service.itemList(pm);
      expect(next.notes).toContain(
        'Dismissed by the user since your last message, don\'t ask again: W1 Q1 "Ship the iPhone build today?"',
      );
      const after = yield* service.itemList(pm);
      expect(after.notes ?? []).not.toContain(next.notes?.[0]);
      // Undo is only possible before the PM heard about it.
      assert.strictEqual((yield* Effect.flip(service.undoDismissAsk(pm, 1))).code, "conflict");
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("undo dismiss reopens the ask; snooze and wake keep it open", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* withAsk(pm, true);
      yield* service.dismissAsk(pm, 1);
      yield* service.undoDismissAsk(pm, 1);
      yield* service.snoozeAsk(pm, 1, "2026-01-01T10:00:00.000Z");
      let ask = (yield* service.detail(pm))!.asks[0]!;
      expect(ask).toMatchObject({ state: "open", snoozedUntil: "2026-01-01T10:00:00.000Z" });
      yield* service.snoozeAsk(pm, 1, null);
      ask = (yield* service.detail(pm))!.asks[0]!;
      expect(ask).toMatchObject({ state: "open", snoozedUntil: null });
      assert.strictEqual((yield* service.detail(pm))!.items[0]!.shownStatus, "blocked");
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("a snoozed ask is not Needs you until it wakes; the sweep clears a due snooze", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* withAsk(pm);
      const rowState = Effect.map(service.summaries(), (event) => event.pms[0]!.rowState);
      assert.strictEqual(yield* rowState, "needs_you");
      const until = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
      yield* service.snoozeAsk(pm, 1, until);
      assert.strictEqual(yield* rowState, "idle");
      yield* service.wakeSnoozedAsks();
      assert.strictEqual((yield* service.detail(pm))!.asks[0]!.snoozedUntil, until);
      yield* TestClock.adjust("61 minutes");
      assert.strictEqual(yield* rowState, "needs_you");
      yield* service.wakeSnoozedAsks();
      expect((yield* service.detail(pm))!.asks[0]).toMatchObject({
        state: "open",
        snoozedUntil: null,
      });
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("an ask the user changed shows in the open-asks note; the PM's own asks do not", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* withAsk(pm);
      yield* service.ask(pm, { title: "Keep the old icon?", detail: "Design asked." });
      assert.isUndefined(
        (yield* service.itemList(pm)).notes?.find((note) => note.startsWith("Still open")),
      );
      yield* service.answerAsk(pm, 1, "Yes");
      expect((yield* service.itemList(pm)).notes).toContain(
        'Still open for the user: Q2 "Keep the old icon?"',
      );
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("panel edits", () => {
  it.effect("reach the PM as labelled user messages", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* service.setMission(pm, "Ship the app.", "user");
      yield* service.setInstructions(pm, "No pushes.", "user");
      const number = yield* service.remember(pm, "Use pnpm.", "user");
      yield* service.editMemory(pm, number, "Use vp.");
      yield* service.forget(pm, number, "user");
      assert.deepStrictEqual(
        messagesTo(world, pm).map((message) => message.text),
        [
          "Mission changed: Ship the app.",
          "Standing instructions changed: No pushes.",
          "Memory note 1 added: Use pnpm.",
          "Memory note 1 changed: Use vp.",
          "Memory note 1 removed: Use vp.",
        ],
      );
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("Live pages", () => {
  it.effect("the first submission wins, with a size cap and Ghostex's answers format", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* service.pageShow(pm, {
        html: "<p>Pick</p>",
        title: "Icon options",
        sourceName: "icons.html",
        questionTags: ["Q1"],
      });
      const page = (yield* service.detail(pm))!.pages[0]!;
      const prepared = yield* service.pageGet(page.pageId);
      expect(prepared.html).toContain("Content-Security-Policy");
      expect(prepared.html).toContain("frame-src 'none'");
      const tooBig = yield* Effect.flip(
        service.pageAnswer(page.pageId, { q: "x".repeat(PAGE_ANSWERS_LIMIT) }),
      );
      assert.strictEqual(tooBig.code, "invalid_request");
      yield* service.pageAnswer(page.pageId, { Q1: "Round" });
      const second = yield* Effect.flip(service.pageAnswer(page.pageId, { Q1: "Square" }));
      assert.strictEqual(second.code, "conflict");
      const sent = messagesTo(world, pm);
      assert.lengthOf(sent, 1);
      assert.strictEqual(
        sent[0]!.text,
        `<pm-page-answers page="${page.pageId}" title="Icon options" tags="Q1">{"Q1":"Round"}</pm-page-answers>`,
      );
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("mark as seen sends nothing unless the user replied", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* service.pageShow(pm, {
        html: "<p>FYI</p>",
        title: "Release plan",
        sourceName: "plan.html",
      });
      const page = (yield* service.detail(pm))!.pages[0]!;
      yield* service.pageMarkSeen(page.pageId, undefined);
      assert.lengthOf(messagesTo(world, pm), 0);
      const seen = (yield* service.detail(pm))!.pages[0]!;
      assert.strictEqual(seen.state, "seen");
      assert.isString(seen.settledAt);
      // The Inbox's Undo of an Archive: the PM never heard of it, so the page opens again.
      yield* service.pageReopen(page.pageId);
      expect((yield* service.detail(pm))!.pages[0]).toMatchObject({
        state: "open",
        settledAt: null,
      });
      yield* service.pageMarkSeen(page.pageId, "Looks good");
      assert.lengthOf(messagesTo(world, pm), 1);
      assert.strictEqual((yield* Effect.flip(service.pageReopen(page.pageId))).code, "conflict");
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("the Inbox's open and snooze reach the page and send the PM nothing", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* service.pageShow(pm, { html: "<p>FYI</p>", title: "Plan", sourceName: "plan.html" });
      const { pageId } = (yield* service.detail(pm))!.pages[0]!;
      assert.isNull((yield* service.detail(pm))!.pages[0]!.openedAt);
      yield* service.pageOpen(pageId);
      const opened = (yield* service.detail(pm))!.pages[0]!.openedAt;
      assert.isString(opened);
      yield* service.pageOpen(pageId);
      assert.strictEqual((yield* service.detail(pm))!.pages[0]!.openedAt, opened);
      yield* service.pageSnooze(pageId, "2026-01-01T10:00:00.000Z");
      assert.strictEqual(
        (yield* service.detail(pm))!.pages[0]!.snoozedUntil,
        "2026-01-01T10:00:00.000Z",
      );
      yield* service.pageSnooze(pageId, null);
      assert.isNull((yield* service.detail(pm))!.pages[0]!.snoozedUntil);
      assert.strictEqual(
        (yield* Effect.flip(service.pageSnooze(pageId, "tomorrow"))).code,
        "invalid_request",
      );
      yield* service.pageMarkSeen(pageId, undefined);
      assert.strictEqual(
        (yield* Effect.flip(service.pageSnooze(pageId, "2026-01-01T10:00:00.000Z"))).code,
        "conflict",
      );
      assert.lengthOf(messagesTo(world, pm), 0);
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("the Inbox's Done rows", () => {
  it.effect("archive and its undo leave the item finished and its update time alone", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* service.itemAdd(pm, { title: "Launch" });
      yield* service.itemUpdate(pm, { item: "W1", status: "done", done: "Shipped." });
      const finished = (yield* service.detail(pm))!.items[0]!;
      assert.isNull(finished.archivedAt);
      yield* service.archiveItems(pm, [1], true);
      const archived = (yield* service.detail(pm))!.items[0]!;
      assert.isString(archived.archivedAt);
      assert.strictEqual(archived.updatedAt, finished.updatedAt);
      assert.strictEqual(archived.status, "finished");
      yield* service.archiveItems(pm, [1], false);
      assert.isNull((yield* service.detail(pm))!.items[0]!.archivedAt);
      assert.strictEqual(
        (yield* Effect.flip(service.archiveItems(pm, [9], true))).code,
        "not_found",
      );
      assert.lengthOf(messagesTo(world, pm), 0);
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("the off switch", () => {
  it.effect(
    "refuses PM commands, empties subscriptions and keeps every row for turning it back on",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const service = yield* PmService;
        const pm = yield* createPm(world);
        yield* withAsk(pm);
        yield* service.setSettings({ enabled: false });
        assert.strictEqual((yield* Effect.flip(service.answerAsk(pm, 1, "Yes"))).code, "disabled");
        assert.strictEqual(
          (yield* Effect.flip(
            service.create({ projectId: PROJECT, createdBy: "user", creationSource: "web" }),
          )).code,
          "disabled",
        );
        const first = yield* service.subscribe().pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(first, [{ enabled: false, pms: [] }]);
        assert.isNull(yield* service.detail(pm));
        assert.lengthOf(messagesTo(world, pm), 0);
        yield* service.setSettings({ enabled: true });
        const summary = (yield* service.summaries()).pms[0]!;
        expect(summary).toMatchObject({
          threadId: pm,
          openAsks: 1,
          openItems: 1,
          rowState: "needs_you",
        });
      }).pipe(Effect.provide(harness(world)));
    },
  );

  it.effect("deleting a PM thread removes its PM rows", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* PmService;
      const pm = yield* createPm(world);
      yield* service.forgetThread(pm);
      assert.deepStrictEqual((yield* service.summaries()).pms, []);
    }).pipe(Effect.provide(harness(world)));
  });
});
