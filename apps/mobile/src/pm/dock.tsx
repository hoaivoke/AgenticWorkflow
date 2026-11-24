import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  PM_INBOX_PHONE_LIMIT,
  PM_SNOOZE_HOURS,
  pmAskTag,
  type PmInbox,
  type PmInboxAnswered,
  type PmInboxMark,
  type PmInboxRow,
  pmInbox,
  pmInboxAge,
  pmInboxAsksQuestion,
  pmInboxHidden,
  pmInboxMarkdown,
} from "@t3tools/pm/client";
import IconArrowBackUp from "@tabler/icons-react-native/IconArrowBackUp";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconCheckbox from "@tabler/icons-react-native/IconCheckbox";
import IconChevronDown from "@tabler/icons-react-native/IconChevronDown";
import IconCircleCheck from "@tabler/icons-react-native/IconCircleCheck";
import IconCircleDot from "@tabler/icons-react-native/IconCircleDot";
import IconCircleHalf2 from "@tabler/icons-react-native/IconCircleHalf2";
import IconCircleMinus from "@tabler/icons-react-native/IconCircleMinus";
import IconExternalLink from "@tabler/icons-react-native/IconExternalLink";
import IconFile from "@tabler/icons-react-native/IconFile";
import IconHelpCircle from "@tabler/icons-react-native/IconHelpCircle";
import IconInbox from "@tabler/icons-react-native/IconInbox";
import IconMessageCircleCheck from "@tabler/icons-react-native/IconMessageCircleCheck";
import IconMessageQuestion from "@tabler/icons-react-native/IconMessageQuestion";
import IconMoon from "@tabler/icons-react-native/IconMoon";
import IconStack from "@tabler/icons-react-native/IconStack";
import IconStarFilled from "@tabler/icons-react-native/IconStarFilled";
import IconX from "@tabler/icons-react-native/IconX";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";
import { type ReactNode, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../components/ui/AppText";
import { Menu } from "../components/ui/Menu";
import { cn } from "../lib/cn";
import { useNowMinuteMs } from "../lib/clock";
import {
  answerAsk,
  archive,
  archiveDone,
  type InboxTarget,
  type InboxUndo,
  markPageOpened,
  mentionInComposer,
  snoozeRow,
} from "./inboxActions";
import { usePmSummary, usePmThreadDetail } from "./state";

// t3code-pm: the Inbox above a PM's composer on the phone, Ghostex's phone dock
// (apps/mobile/app/src/chat/native/cards/WorkCards.tsx in Ghostex) over the shared `pmInbox`.

const PINK = "#f472b6";
const RED = "#ef4444";
const AMBER = "#c68a06";
const GREEN = "#2fa865";
const SWIPE_AT = 68;
const SWIPE_MAX = 104;
const SWIPE_FAIL_Y: [number, number] = [-10, 10];

type Icon = typeof IconInbox;

const MARKS: Record<PmInboxMark, readonly [Icon, string]> = {
  blocked: [IconCircleMinus, RED],
  todo: [IconCheckbox, PINK],
  question: [IconHelpCircle, PINK],
  page: [IconFile, PINK],
  pages: [IconStack, PINK],
  finished: [IconCircleCheck, GREEN],
};

export function PmDock(props: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id">;
  readonly draftKey: string | null;
}) {
  const { environmentId, id: threadId } = props.thread;
  const summary = usePmSummary(environmentId, threadId);
  if (summary === null) return null;
  return <Dock target={{ environmentId, threadId }} draftKey={props.draftKey} />;
}

interface RowContext {
  readonly target: InboxTarget;
  readonly draftKey: string | null;
  readonly now: number;
  readonly muted: string;
  readonly onUndo: (undo: InboxUndo | null) => void;
}

function Dock(props: { readonly target: InboxTarget; readonly draftKey: string | null }) {
  const gt = useGT();
  const navigation = useNavigation();
  const now = useNowMinuteMs();
  const detail = usePmThreadDetail(props.target.environmentId, props.target.threadId);
  const { color: muted } = useResolveClassNames("text-foreground-muted");
  const [folded, setFolded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [undo, setUndo] = useState<(InboxUndo & { readonly id: number }) | null>(null);
  if (detail === null) return null;
  const inbox = pmInbox(detail, now);
  const empty =
    inbox.rows.length === 0 &&
    inbox.done.length === 0 &&
    inbox.snoozed.length === 0 &&
    inbox.answered.length === 0 &&
    inbox.counts.inProgress === 0;
  if (empty) return null;
  const mutedColor = typeof muted === "string" ? muted : "#888";
  const onUndo = (next: InboxUndo | null) => {
    if (next === null) return;
    const id = Date.now();
    setUndo({ ...next, id });
    setTimeout(() => setUndo((current) => (current?.id === id ? null : current)), 8000);
  };
  const context: RowContext = {
    target: props.target,
    draftKey: props.draftKey,
    now,
    muted: mutedColor,
    onUndo,
  };
  const shown = showAll ? inbox.rows : inbox.rows.slice(0, PM_INBOX_PHONE_LIMIT);
  const hidden = pmInboxHidden(inbox.rows.slice(PM_INBOX_PHONE_LIMIT));
  const moreParts = [
    hidden.pings > 0
      ? gt("{count, plural, one {# more ping} other {# more pings}}", { count: hidden.pings })
      : null,
    hidden.blocked > 0 ? gt("{count} more blocked", { count: hidden.blocked }) : null,
    hidden.done > 0 ? gt("{count} more done", { count: hidden.done }) : null,
  ].filter((part): part is string => part !== null);
  const openWork = () => navigation.navigate("PmSheet", props.target);

  return (
    <View
      className={cn(
        "mx-3 mb-2 overflow-hidden rounded-xl border border-border",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !folded }}
        onPress={() => setFolded(!folded)}
        className={cn(
          "h-[38px] flex-row items-center gap-3 pl-3 pr-2",
          !folded && "border-b border-border bg-subtle",
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <IconInbox size={15} color={mutedColor} />
          <Text className="text-[13px] font-t3-semibold text-foreground">{gt("Inbox")}</Text>
        </View>
        {inbox.counts.pings > 0 ? (
          <Chip icon={IconCircleDot} color={PINK} muted={mutedColor} onPress={openWork}>
            {gt("{count, plural, one {# ping} other {# pings}}", { count: inbox.counts.pings })}
          </Chip>
        ) : null}
        {inbox.counts.blocked > 0 ? (
          <Chip icon={IconCircleMinus} color={RED} muted={mutedColor} onPress={openWork}>
            {gt("{count} blocked", { count: inbox.counts.blocked, $context: "Inbox count" })}
          </Chip>
        ) : null}
        {inbox.counts.inProgress > 0 ? (
          <Chip icon={IconCircleHalf2} color={AMBER} muted={mutedColor} onPress={openWork}>
            {gt("{count} in progress", {
              count: inbox.counts.inProgress,
              $context: "Inbox count",
            })}
          </Chip>
        ) : null}
        <View className="flex-1" />
        <View style={folded ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <IconChevronDown size={15} color={mutedColor} />
        </View>
      </Pressable>
      {folded ? null : (
        <>
          {shown.length > 0 ? (
            <View className="p-1">
              {shown.map((row) => (
                <InboxRow key={row.key} row={row} context={context} />
              ))}
              {moreParts.length > 0 && !showAll ? (
                <MoreLine onPress={() => setShowAll(true)}>{moreParts.join(" · ")}</MoreLine>
              ) : null}
              {showAll && inbox.rows.length > PM_INBOX_PHONE_LIMIT ? (
                <MoreLine onPress={() => setShowAll(false)}>{gt("Show fewer")}</MoreLine>
              ) : null}
            </View>
          ) : null}
          {inbox.archiveAll ? (
            <ArchiveAll
              inbox={inbox}
              onPress={() => void archive(props.target, inbox.archiveAll ?? {}).then(onUndo)}
            />
          ) : null}
          {undo ? (
            <View className="h-10 flex-row items-center gap-2 border-t border-border pl-3 pr-2">
              <IconArchive size={15} color={mutedColor} />
              <Text className="flex-1 text-[13px] text-foreground-muted">
                {gt("Archived {count}", { count: undo.count })}
              </Text>
              <TextButton
                onPress={() => {
                  setUndo(null);
                  void undo.undo();
                }}
              >
                {gt("Undo")}
              </TextButton>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Close")}
                className="size-8 items-center justify-center"
                onPress={() => setUndo(null)}
              >
                <IconX size={15} color={mutedColor} />
              </Pressable>
            </View>
          ) : null}
          {inbox.done.length > 0 ? (
            <Drawer
              icon={IconCircleCheck}
              color={GREEN}
              muted={mutedColor}
              label={gt("Done", { $context: "Inbox drawer of finished work" })}
              count={inbox.done.length}
              action={
                inbox.done.length >= 2 ? (
                  <TextButton
                    onPress={() =>
                      void archiveDone(
                        props.target,
                        inbox.done.map((row) => row.item.itemNo),
                      ).then(onUndo)
                    }
                  >
                    {gt("Archive all")}
                  </TextButton>
                ) : null
              }
            >
              {inbox.done.map((row) => (
                <InboxRow key={row.key} row={row} context={context} drawer />
              ))}
            </Drawer>
          ) : null}
          {inbox.snoozed.length > 0 ? (
            <Drawer
              icon={IconMoon}
              color={mutedColor}
              muted={mutedColor}
              label={gt("Snoozed")}
              count={inbox.snoozed.length}
            >
              {inbox.snoozed.map((row) => (
                <InboxRow key={row.key} row={row} context={context} drawer />
              ))}
            </Drawer>
          ) : null}
          {inbox.answered.length > 0 ? (
            <Drawer
              icon={IconMessageCircleCheck}
              color={GREEN}
              muted={mutedColor}
              label={gt("Answered")}
              count={inbox.answered.length}
            >
              {inbox.answered.map((row) => (
                <AnsweredRow key={row.key} row={row} now={now} />
              ))}
            </Drawer>
          ) : null}
        </>
      )}
    </View>
  );
}

function Chip(props: {
  readonly icon: Icon;
  readonly color: string;
  readonly muted: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const IconView = props.icon;
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      className="flex-row items-center gap-1"
      onPress={props.onPress}
    >
      <IconView size={13} color={props.color} />
      <Text className="text-[13px] text-foreground-muted">{props.children}</Text>
    </Pressable>
  );
}

function TextButton(props: { readonly onPress: () => void; readonly children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      className="h-[28px] flex-row items-center gap-1 rounded-md bg-subtle px-2.5"
      onPress={props.onPress}
    >
      {typeof props.children === "string" ? (
        <Text className="text-[13px] font-t3-medium text-foreground">{props.children}</Text>
      ) : (
        props.children
      )}
    </Pressable>
  );
}

function IconPress(props: {
  readonly icon: Icon;
  readonly label: string;
  readonly color: string;
  readonly onPress: () => void;
}) {
  const IconView = props.icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      className="size-[28px] items-center justify-center rounded-md"
      onPress={props.onPress}
    >
      <IconView size={16} color={props.color} />
    </Pressable>
  );
}

function CountBadge(props: { readonly count: number }) {
  return (
    <View className="h-4 min-w-4 items-center justify-center rounded-full bg-subtle px-1">
      <Text className="text-[11px] font-t3-medium text-foreground">{props.count}</Text>
    </View>
  );
}

function MoreLine(props: { readonly onPress: () => void; readonly children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" className="py-1.5 pl-[31px] pr-2" onPress={props.onPress}>
      <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
        {props.children}
      </Text>
    </Pressable>
  );
}

function ArchiveAll(props: { readonly inbox: PmInbox; readonly onPress: () => void }) {
  const gt = useGT();
  const pages = props.inbox.archiveAll?.pageIds.length ?? 0;
  const todos = props.inbox.archiveAll?.askNos.length ?? 0;
  const summary = [
    pages > 0 ? gt("{count, plural, one {# page} other {# pages}}", { count: pages }) : null,
    todos > 0 ? gt("{count, plural, one {# to-do} other {# to-dos}}", { count: todos }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="h-10 flex-row items-center gap-2 border-t border-border pl-3 pr-2">
      <Text className="flex-1 text-[13px] text-foreground-muted" numberOfLines={1}>
        {summary}
      </Text>
      <TextButton onPress={props.onPress}>
        <Text className="text-[13px] font-t3-medium text-foreground">{gt("Archive all")}</Text>
        <CountBadge count={pages + todos} />
      </TextButton>
    </View>
  );
}

function Drawer(props: {
  readonly icon: Icon;
  readonly color: string;
  readonly muted: string;
  readonly label: string;
  readonly count: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const IconView = props.icon;
  return (
    <View className="border-t border-border">
      <View className="h-9 flex-row items-center gap-2 pl-3 pr-2">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          className="flex-1 flex-row items-center gap-1.5"
          onPress={() => setOpen(!open)}
        >
          <IconView size={13} color={props.color} />
          <Text className="text-[13px] text-foreground-muted">{props.label}</Text>
          <CountBadge count={props.count} />
          <View style={open ? undefined : { transform: [{ rotate: "-90deg" }] }}>
            <IconChevronDown size={14} color={props.muted} />
          </View>
        </Pressable>
        {open ? props.action : null}
      </View>
      {open ? <View className="px-1 pb-1 opacity-70">{props.children}</View> : null}
    </View>
  );
}

function ageLabel(gt: ReturnType<typeof useGT>, at: string, now: number): string {
  const age = pmInboxAge(at, now);
  switch (age.unit) {
    case "now":
      return gt("now", { $context: "Inbox row age" });
    case "m":
      return gt("{count}m", { count: age.value, $context: "Inbox row age in minutes" });
    case "h":
      return gt("{count}h", { count: age.value, $context: "Inbox row age in hours" });
    case "yesterday":
      return gt("yesterday", { $context: "Inbox row age" });
    case "d":
      return gt("{count}d", { count: age.value, $context: "Inbox row age in days" });
  }
}

function AnsweredRow(props: { readonly row: PmInboxAnswered; readonly now: number }) {
  const gt = useGT();
  return (
    <View className="flex-row items-center gap-2 py-2 pl-6 pr-2">
      <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={1}>
        {props.row.title}
      </Text>
      {props.row.outcome ? (
        <View className="max-w-[40%] rounded-full px-2" style={{ backgroundColor: `${GREEN}24` }}>
          <Text className="text-xs" style={{ color: GREEN }} numberOfLines={1}>
            {props.row.outcome}
          </Text>
        </View>
      ) : null}
      <Text className="text-xs text-foreground-muted">{ageLabel(gt, props.row.at, props.now)}</Text>
    </View>
  );
}

function rowArchive(context: RowContext, row: PmInboxRow): (() => void) | null {
  const run = (pending: () => Promise<InboxUndo | null>) => () =>
    void pending().then(context.onUndo);
  switch (row.kind) {
    case "ask":
      return run(() => archive(context.target, { askNos: [row.ask.askNo] }));
    case "page":
      return run(() => archive(context.target, { pageIds: [row.page.pageId] }));
    case "pages":
      return run(() => archive(context.target, { pageIds: row.pages.map((page) => page.pageId) }));
    case "finished":
      return run(() => archiveDone(context.target, [row.item.itemNo]));
    case "blocked":
      return null;
  }
}

/** A right swipe's Snooze sheet, titled with the row. */
function openSnoozeSheet(
  gt: ReturnType<typeof useGT>,
  context: RowContext,
  row: PmInboxRow,
  title: string,
) {
  const label = (hours: number) =>
    gt("{count, plural, one {# hour} other {# hours}}", { count: hours, $context: "Snooze for" });
  const heading = gt('Snooze "{title}"', { title });
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: heading,
        options: [...PM_SNOOZE_HOURS.map(label), gt("Cancel")],
        cancelButtonIndex: PM_SNOOZE_HOURS.length,
      },
      (index) => {
        const hours = PM_SNOOZE_HOURS[index];
        if (hours !== undefined) void snoozeRow(context.target, row, hours);
      },
    );
    return;
  }
  // Android's alert holds three buttons; a tap outside cancels.
  Alert.alert(
    heading,
    undefined,
    PM_SNOOZE_HOURS.map((hours) => ({
      text: label(hours),
      onPress: () => void snoozeRow(context.target, row, hours),
    })),
    { cancelable: true },
  );
}

function SwipeStrip(props: {
  readonly side: "left" | "right";
  readonly icon: Icon;
  readonly label: string;
}) {
  const IconView = props.icon;
  const color = props.side === "left" ? "#86efac" : "#93c5fd";
  return (
    <View
      className={cn(
        "flex-1 flex-row items-center gap-1.5 rounded-lg px-4",
        props.side === "left" ? "justify-end" : "justify-start",
      )}
      style={{ backgroundColor: props.side === "left" ? "#214e36" : "#273c56" }}
    >
      <IconView size={16} color={color} />
      <Text className="text-[13px] font-t3-medium" style={{ color }}>
        {props.label}
      </Text>
    </View>
  );
}

/** Ghostex's phone swipes: past 68pt a left swipe archives or dismisses, a right one snoozes. */
function RowSwipe(props: {
  readonly left: { readonly icon: Icon; readonly label: string; readonly run: () => void } | null;
  readonly right: { readonly label: string; readonly run: () => void } | null;
  readonly children: ReactNode;
}) {
  const swipeable = useRef<SwipeableMethods | null>(null);
  if (props.left === null && props.right === null) return props.children;
  const { left, right } = props;
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={1}
      leftThreshold={SWIPE_AT}
      rightThreshold={SWIPE_AT}
      // Vertical pans stay the chat's scroll.
      failOffsetY={SWIPE_FAIL_Y}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={
        right
          ? () => (
              <View style={{ width: SWIPE_MAX }}>
                <SwipeStrip side="right" icon={IconMoon} label={right.label} />
              </View>
            )
          : undefined
      }
      renderRightActions={
        left
          ? () => (
              <View style={{ width: SWIPE_MAX }}>
                <SwipeStrip side="left" icon={left.icon} label={left.label} />
              </View>
            )
          : undefined
      }
      onSwipeableOpen={(direction) => {
        swipeable.current?.close();
        if (direction === "left") left?.run();
        else right?.run();
      }}
    >
      {props.children}
    </ReanimatedSwipeable>
  );
}

function InboxRow(props: {
  readonly row: PmInboxRow;
  readonly context: RowContext;
  readonly drawer?: boolean;
  readonly nested?: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { row, context } = props;
  const [expanded, setExpanded] = useState(false);
  const asks = pmInboxAsksQuestion(row);
  const archiveRow = rowArchive(context, row);
  const snoozable = row.kind === "ask" || row.kind === "page";
  const title =
    row.kind === "ask"
      ? row.ask.title
      : row.kind === "page"
        ? row.page.title
        : row.kind === "pages"
          ? row.lastTurn
            ? gt("{count} pages from last turn", { count: row.pages.length })
            : gt("{count} pages from an earlier turn", { count: row.pages.length })
          : row.item.title;
  const preview =
    row.kind === "ask"
      ? row.preview
      : row.kind === "blocked"
        ? (row.item.nowLine ?? "")
        : row.kind === "finished"
          ? (row.item.doneLine ?? "")
          : "";

  const openAsk = (askNo: number) =>
    navigation.navigate("PmAsk", { ...context.target, askNo, draftKey: context.draftKey });
  const openPage = (pageId: string, openedAt: string | null | undefined) => {
    navigation.navigate("PmPage", { ...context.target, pageId });
    if (!openedAt) void markPageOpened(context.target, pageId);
  };
  const reply = () => {
    if (row.kind === "ask") openAsk(row.ask.askNo);
    else if (row.kind === "page")
      navigation.navigate("PmAsk", {
        ...context.target,
        pageId: row.page.pageId,
        draftKey: context.draftKey,
      });
  };
  const onPress = () => {
    if (row.kind === "ask") openAsk(row.ask.askNo);
    else if (row.kind === "page") openPage(row.page.pageId, row.page.openedAt);
    else if (row.kind === "pages") setExpanded(!expanded);
    else navigation.navigate("PmSheet", context.target);
  };

  const swipeLeft = props.drawer ? null : archiveRow;
  const swipeRight =
    props.drawer || !snoozable ? null : () => openSnoozeSheet(gt, context, row, title);

  const menuActions = [
    ...(row.snoozedUntil !== null
      ? [{ id: "unsnooze", title: gt("Unsnooze"), image: "moon.zzz" }]
      : []),
    ...(row.kind === "ask" && !row.todo
      ? [{ id: "answered", title: gt("Mark answered"), image: "checkmark.circle" }]
      : []),
    ...(archiveRow
      ? [
          {
            id: "archive",
            title: asks ? gt("Dismiss") : gt("Archive"),
            image: asks ? "xmark" : "checkmark",
          },
        ]
      : []),
    ...(snoozable && row.snoozedUntil === null
      ? [
          {
            id: "snooze",
            title: gt("Snooze"),
            image: "moon",
            subactions: PM_SNOOZE_HOURS.map((hours) => ({
              id: `snooze:${hours}`,
              title: gt("{count, plural, one {# hour} other {# hours}}", {
                count: hours,
                $context: "Snooze for",
              }),
            })),
          },
        ]
      : []),
    ...(pmInboxMarkdown(row)
      ? [{ id: "markdown", title: gt("Copy as Markdown"), image: "doc.on.doc" }]
      : []),
    ...(row.kind === "ask" && context.draftKey !== null
      ? [{ id: "mention", title: gt("Mention in chat box"), image: "quote.opening" }]
      : []),
  ];
  const onMenu = (event: string) => {
    if (event === "unsnooze") void snoozeRow(context.target, row, null);
    else if (event === "answered" && row.kind === "ask")
      void answerAsk(context.target, row.ask.askNo, "I answered this in the chat.");
    else if (event === "archive") archiveRow?.();
    else if (event.startsWith("snooze:"))
      void snoozeRow(context.target, row, Number(event.slice("snooze:".length)));
    else if (event === "markdown") void Clipboard.setStringAsync(pmInboxMarkdown(row));
    else if (event === "mention" && row.kind === "ask")
      mentionInComposer(context.draftKey, pmAskTag(row.ask));
  };

  const buttons: Array<ReactNode> = [];
  if (props.drawer) {
    if (row.kind === "finished" && archiveRow)
      buttons.push(
        <IconPress
          key="archive"
          icon={IconCheck}
          label={gt("Archive")}
          color={context.muted}
          onPress={archiveRow}
        />,
      );
  } else if (row.kind === "pages") {
    buttons.push(
      <TextButton key="expand" onPress={() => setExpanded(!expanded)}>
        {expanded ? gt("Collapse") : gt("Expand")}
      </TextButton>,
    );
  } else {
    if (!asks && archiveRow && row.kind !== "finished")
      buttons.push(
        <IconPress
          key="archive"
          icon={IconCheck}
          label={gt("Archive")}
          color={context.muted}
          onPress={archiveRow}
        />,
      );
    if (row.kind === "ask") {
      const answers = row.todo ? [gt("Done", { $context: "answer to a to-do" })] : row.ask.answers;
      const fits = !row.details && answers.length <= 2 && answers.join("").length <= 18;
      if (fits)
        for (const answer of answers)
          buttons.push(
            <TextButton
              key={answer}
              onPress={() => void answerAsk(context.target, row.ask.askNo, answer)}
            >
              <View className="flex-row items-center gap-1">
                {answer === row.ask.recommended ? (
                  <IconStarFilled size={11} color="#f5b301" />
                ) : null}
                <Text className="text-[13px] font-t3-medium text-foreground">{answer}</Text>
              </View>
            </TextButton>,
          );
      else
        buttons.push(
          <IconPress
            key="details"
            icon={IconMessageQuestion}
            label={gt("Details")}
            color={context.muted}
            onPress={() => openAsk(row.ask.askNo)}
          />,
        );
    }
    if (row.kind === "page")
      buttons.push(
        <IconPress
          key="open"
          icon={IconExternalLink}
          label={gt("Open", { $context: "open a Live page" })}
          color={context.muted}
          onPress={() => openPage(row.page.pageId, row.page.openedAt)}
        />,
      );
    if (row.kind === "ask" || row.kind === "page")
      buttons.push(
        <IconPress
          key="reply"
          icon={IconArrowBackUp}
          label={gt("Reply")}
          color={context.muted}
          onPress={reply}
        />,
      );
  }

  const [MarkIcon, markColor] = MARKS[row.mark];
  const age =
    row.snoozedUntil !== null
      ? ageLabel(gt, new Date(context.now).toISOString(), Date.parse(row.snoozedUntil))
      : ageLabel(gt, row.at, context.now);

  return (
    <View className={cn(props.nested && "ml-[23px] border-l border-border pl-1")}>
      <RowSwipe
        left={
          swipeLeft
            ? {
                icon: asks ? IconX : IconCheck,
                label: asks ? gt("Dismiss") : gt("Archive"),
                run: swipeLeft,
              }
            : null
        }
        right={swipeRight ? { label: gt("Snooze"), run: swipeRight } : null}
      >
        <Menu
          accessibilityLabel={title}
          shouldOpenOnLongPress
          actions={menuActions}
          onPressAction={({ nativeEvent }) => onMenu(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            onPress={onPress}
            className={cn(
              "rounded-lg px-2 py-1.5",
              Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
            )}
          >
            <View className="flex-row items-center gap-2.5">
              <MarkIcon size={13} color={markColor} />
              <Text
                className={cn(
                  "flex-1 text-sm",
                  row.unread ? "text-foreground" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {title}
              </Text>
              <View className="flex-row items-center gap-1">{buttons}</View>
              <Text className="min-w-[26px] text-right text-xs text-foreground-muted">{age}</Text>
            </View>
            {preview ? (
              <Text className="pl-[23px] text-[13px] text-foreground-muted" numberOfLines={1}>
                {preview}
              </Text>
            ) : null}
          </Pressable>
        </Menu>
      </RowSwipe>
      {row.kind === "pages" && expanded
        ? row.pages.map((page) => (
            <InboxRow
              key={page.pageId}
              nested
              context={context}
              row={{
                kind: "page",
                key: `page:${page.pageId}`,
                at: page.createdAt,
                mark: "page",
                unread: !page.openedAt,
                snoozedUntil: null,
                page,
                seenOnly: true,
              }}
            />
          ))
        : null}
    </View>
  );
}
