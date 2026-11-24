import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  PM_ANSWERED_IN_CHAT,
  PM_INBOX_PHONE_LIMIT,
  PM_SNOOZE_HOURS,
  pmAskTag,
  type PmInbox,
  type PmInboxHandled,
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
import IconDots from "@tabler/icons-react-native/IconDots";
import IconExternalLink from "@tabler/icons-react-native/IconExternalLink";
import IconFile from "@tabler/icons-react-native/IconFile";
import IconHelpCircle from "@tabler/icons-react-native/IconHelpCircle";
import IconInbox from "@tabler/icons-react-native/IconInbox";
import IconLayoutBoardSplit from "@tabler/icons-react-native/IconLayoutBoardSplit";
import IconMessageCircleCheck from "@tabler/icons-react-native/IconMessageCircleCheck";
import IconMoon from "@tabler/icons-react-native/IconMoon";
import IconStack from "@tabler/icons-react-native/IconStack";
import IconStarFilled from "@tabler/icons-react-native/IconStarFilled";
import IconX from "@tabler/icons-react-native/IconX";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";
import { type ReactNode, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
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
  archiveRecent,
  type InboxTarget,
  type InboxUndo,
  markPageOpened,
  mentionInComposer,
  replyToPage,
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
  readonly dark: boolean;
}

const UNDO_MS = 10_000;
const DOCK_MAX_HEIGHT = 420;
const DOCK_HEAD_HEIGHT = 39;
const DOCK_MIN_ROWS = 44;

/** Ghostex's `dockHeightCap`: under half the room left beside the keyboard, at most 420pt. */
function useRowsMaxHeight() {
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardState((state) => state.height);
  const cap = Math.min(
    DOCK_MAX_HEIGHT,
    Math.max(0, height - keyboard) * (keyboard > 0 ? 0.5 : 0.45),
  );
  return Math.max(DOCK_MIN_ROWS, Math.min(DOCK_MAX_HEIGHT, cap - DOCK_HEAD_HEIGHT));
}

function Dock(props: { readonly target: InboxTarget; readonly draftKey: string | null }) {
  const gt = useGT();
  const navigation = useNavigation();
  const now = useNowMinuteMs();
  const dark = useColorScheme() === "dark";
  const maxHeight = useRowsMaxHeight();
  const detail = usePmThreadDetail(props.target.environmentId, props.target.threadId);
  const { color: muted } = useResolveClassNames("text-foreground-muted");
  const { color: foreground } = useResolveClassNames("text-foreground");
  const [hiddenRows, setHiddenRows] = useState<ReadonlySet<string> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [undo, setUndo] = useState<(InboxUndo & { readonly id: number }) | null>(null);
  // Recent rows archived on this phone: answers have no server-side archive, as in Ghostex.
  const [archived, setArchived] = useState<ReadonlySet<string>>(() => new Set());
  if (detail === null) return null;
  const inbox = pmInbox(detail, now, archived);
  const setHandled = (keys: ReadonlyArray<string>, on: boolean) =>
    setArchived((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const content =
    inbox.rows.length + inbox.snoozed.length + inbox.recent.length > 0 || undo !== null;
  // Ghostex's `work_dock_hidden`: folded only while every row now was there when it was folded.
  const folded =
    content &&
    undo === null &&
    hiddenRows !== null &&
    inbox.rows.every((row) => hiddenRows.has(row.key));
  const mutedColor = typeof muted === "string" ? muted : "#888";
  const onUndo = (next: InboxUndo | null) => {
    if (next === null) return;
    const id = Date.now();
    setUndo({ ...next, id });
    setTimeout(() => setUndo((current) => (current?.id === id ? null : current)), UNDO_MS);
  };
  const context: RowContext = {
    target: props.target,
    draftKey: props.draftKey,
    now,
    muted: mutedColor,
    dark,
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
  const { counts } = inbox;
  const quiet = counts.pings + counts.blocked + counts.inProgress === 0;
  const more = inbox.rows.length > PM_INBOX_PHONE_LIMIT;

  return (
    <View
      className={cn(
        "mx-3 mb-2 overflow-hidden rounded-xl border border-border",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={content ? { expanded: !folded } : undefined}
        disabled={!content}
        onPress={() => setHiddenRows(folded ? null : new Set(inbox.rows.map((row) => row.key)))}
        className={cn(
          "h-[36px] flex-row items-center gap-1.5 pl-3 pr-1.5",
          content && !folded && "border-b border-border bg-subtle",
        )}
      >
        <View className={cn("flex-row items-center gap-[5px]", (!quiet || !content) && "mr-1.5")}>
          <IconInbox size={14} color={typeof foreground === "string" ? foreground : mutedColor} />
          <Text className="text-[13px] font-t3-semibold text-foreground">{gt("Inbox")}</Text>
        </View>
        {quiet && !content ? (
          <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
            {gt("Nothing in progress")}
          </Text>
        ) : null}
        {counts.pings > 0 ? (
          <Chip
            icon={IconCircleDot}
            color={PINK}
            count={counts.pings}
            word={gt("{count, plural, one {ping} other {pings}}", {
              count: counts.pings,
              $context: "Inbox count word after its number",
            })}
            onPress={openWork}
          />
        ) : null}
        {counts.blocked > 0 ? (
          <Chip
            icon={IconCircleMinus}
            color={RED}
            count={counts.blocked}
            word={gt("blocked", { $context: "Inbox count word after its number" })}
            onPress={openWork}
          />
        ) : null}
        {counts.inProgress > 0 ? (
          <Chip
            icon={IconCircleHalf2}
            color={AMBER}
            count={counts.inProgress}
            word={gt("in progress", { $context: "Inbox count word after its number" })}
            onPress={openWork}
          />
        ) : null}
        <View className="flex-1" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Work items")}
          className="h-[26px] w-[28px] items-center justify-center rounded-md"
          onPress={openWork}
        >
          <IconLayoutBoardSplit size={14} color={mutedColor} />
        </Pressable>
        {content ? (
          <View
            className="h-[26px] w-[28px] items-center justify-center"
            style={folded ? { transform: [{ rotate: "180deg" }] } : undefined}
          >
            <IconChevronDown size={14} color={mutedColor} />
          </View>
        ) : null}
      </Pressable>
      {!content || folded ? null : (
        <ScrollView nestedScrollEnabled style={{ maxHeight }} contentContainerClassName="p-1">
          {shown.map((row) => (
            <InboxRow key={row.key} row={row} context={context} />
          ))}
          {/* Ghostex's foot: "N more" (or Show fewer) shares a line with Archive all; with nothing
              hidden, Archive all sits alone under a hairline. */}
          {more || inbox.archiveAll ? (
            <View
              className={cn(
                "flex-row items-center gap-2 pr-2",
                more ? "pb-1.5 pt-0.5" : "mt-0.5 border-t border-border pb-1 pt-[5px] pl-2",
              )}
            >
              {more ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showAll }}
                  hitSlop={8}
                  className="shrink pl-[31px]"
                  onPress={() => setShowAll(!showAll)}
                >
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {showAll ? gt("Show fewer") : moreParts.join(" · ")}
                  </Text>
                </Pressable>
              ) : null}
              {inbox.archiveAll ? (
                <ArchiveAll
                  inbox={inbox}
                  summary={!more}
                  onPress={() => void archive(props.target, inbox.archiveAll ?? {}).then(onUndo)}
                />
              ) : null}
            </View>
          ) : null}
          {undo ? (
            <View className="mt-1 flex-row items-center gap-2 rounded-lg border border-border bg-subtle px-2 py-1.5">
              <IconArchive size={13} color={mutedColor} />
              <Text className="flex-1 text-[13.5px] text-foreground" numberOfLines={1}>
                {gt("Archived {count}", { count: undo.count })}
              </Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                className="rounded-md border border-border bg-subtle px-2.5 py-[3px]"
                onPress={() => {
                  setUndo(null);
                  void undo.undo();
                }}
              >
                <Text className="text-[13px] font-t3-semibold text-foreground">{gt("Undo")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Dismiss")}
                hitSlop={8}
                className="size-[22px] items-center justify-center rounded-[5px]"
                onPress={() => setUndo(null)}
              >
                <IconX size={12} color={mutedColor} />
              </Pressable>
            </View>
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
          {inbox.recent.length > 0 ? (
            <Drawer
              icon={IconCircleCheck}
              color={GREEN}
              muted={mutedColor}
              label={gt("Recent", {
                $context: "Inbox drawer of finished work and answered questions",
              })}
              count={inbox.recent.length}
              action={
                <QuietButton
                  label={gt("Archive all, {count}", { count: inbox.recent.length })}
                  onPress={() =>
                    void archiveRecent(props.target, inbox.recent, setHandled).then(onUndo)
                  }
                >
                  {gt("Archive all")}
                </QuietButton>
              }
            >
              {inbox.recent.map((row) =>
                row.kind === "finished" ? (
                  <InboxRow key={row.key} row={row} context={context} drawer />
                ) : (
                  <HandledRow key={row.key} row={row} now={now} />
                ),
              )}
            </Drawer>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function Chip(props: {
  readonly icon: Icon;
  readonly color: string;
  readonly count: number;
  readonly word: string;
  readonly onPress: () => void;
}) {
  const IconView = props.icon;
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      className="flex-row items-center gap-[5px] rounded-md px-1.5 py-0.5"
      onPress={props.onPress}
    >
      <IconView size={13} color={props.color} />
      <Text className="text-[13px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
        {props.count}
      </Text>
      <Text className="text-[13px] text-foreground-muted">{props.word}</Text>
    </Pressable>
  );
}

function TextButton(props: { readonly onPress: () => void; readonly children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      className="h-[28px] flex-row items-center gap-1.5 rounded-lg bg-subtle px-2.5"
      onPress={props.onPress}
    >
      {typeof props.children === "string" ? (
        <Text className="text-sm text-foreground">{props.children}</Text>
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
      className="size-[28px] items-center justify-center rounded-lg bg-subtle"
      onPress={props.onPress}
    >
      <IconView size={14} color={props.color} />
    </Pressable>
  );
}

/** Ghostex's quiet bordered button: the Archive alls and a bundle's Expand. */
function QuietButton(props: {
  readonly onPress: () => void;
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      className="flex-row items-center gap-1.5 rounded-md border border-border bg-subtle px-2 py-[3px]"
      onPress={(event) => {
        event.stopPropagation();
        props.onPress();
      }}
    >
      {typeof props.children === "string" ? (
        <Text className="text-[12.5px] text-foreground">{props.children}</Text>
      ) : (
        props.children
      )}
    </Pressable>
  );
}

function CountBadge(props: { readonly count: number }) {
  return (
    <View className="h-[18px] min-w-[18px] items-center justify-center rounded-full bg-subtle px-1">
      <Text className="text-[11px] font-t3-medium text-foreground opacity-80">{props.count}</Text>
    </View>
  );
}

function ArchiveAll(props: {
  readonly inbox: PmInbox;
  readonly summary: boolean;
  readonly onPress: () => void;
}) {
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
    <>
      <Text className="flex-1 text-[12.5px] text-foreground-muted" numberOfLines={1}>
        {props.summary ? summary : ""}
      </Text>
      <QuietButton
        label={gt("Archive all, {count}", { count: pages + todos })}
        onPress={props.onPress}
      >
        <Text className="text-[13px] text-foreground">{gt("Archive all")}</Text>
        <CountBadge count={pages + todos} />
      </QuietButton>
    </>
  );
}

/** Snoozed or Recent under the rows: Ghostex's drawer line, folded until tapped. */
function Drawer(props: {
  readonly icon: Icon;
  readonly color: string;
  readonly muted: string;
  readonly label: string;
  readonly count: number;
  /** Shown on the line while the drawer is open. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const IconView = props.icon;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.count}`}
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-2.5 rounded-lg px-2 py-1.5"
        onPress={() => setOpen(!open)}
      >
        <IconView size={13} color={props.color} />
        <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.label}
          </Text>
          <CountBadge count={props.count} />
        </View>
        {open ? props.action : null}
        <View style={open ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <IconChevronDown size={12} color={props.muted} />
        </View>
      </Pressable>
      {open ? <View className="opacity-[0.72]">{props.children}</View> : null}
    </>
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

/** An answered ask or page in Recent: Ghostex's quiet line. */
function HandledRow(props: { readonly row: PmInboxHandled; readonly now: number }) {
  const gt = useGT();
  return (
    <View className="flex-row items-center gap-2.5 rounded-lg px-2 py-[5px]">
      <IconMessageCircleCheck size={13} color={GREEN} />
      <Text className="flex-1 text-[13.5px] text-foreground-muted" numberOfLines={1}>
        {props.row.title}
      </Text>
      {props.row.outcome ? (
        <View className="max-w-[130px] rounded-[5px] bg-subtle px-1.5 py-px">
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.row.outcome}
          </Text>
        </View>
      ) : null}
      <Text className="text-sm text-foreground-muted">{ageLabel(gt, props.row.at, props.now)}</Text>
    </View>
  );
}

/** One row's Archive or Dismiss: silent, as only the bulk Archive all gets the Undo bar. */
function rowArchive(context: RowContext, row: PmInboxRow): (() => void) | null {
  const run = (pending: () => Promise<unknown>) => () => void pending();
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

const SWIPE_COLORS = {
  left: { light: ["#dcfce7", "#15803d"], dark: ["#214e36", "#86efac"] },
  right: { light: ["#dbeafe", "#1d4ed8"], dark: ["#273c56", "#93c5fd"] },
} as const;

function SwipeStrip(props: {
  readonly side: "left" | "right";
  readonly icon: Icon;
  readonly label: string;
  readonly dark: boolean;
}) {
  const IconView = props.icon;
  const [background, color] = SWIPE_COLORS[props.side][props.dark ? "dark" : "light"];
  return (
    <View
      className={cn(
        "flex-1 flex-row items-center gap-1.5 rounded-lg px-4",
        props.side === "left" ? "justify-end" : "justify-start",
      )}
      style={{ backgroundColor: background }}
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
  readonly dark: boolean;
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
                <SwipeStrip side="right" icon={IconMoon} label={right.label} dark={props.dark} />
              </View>
            )
          : undefined
      }
      renderRightActions={
        left
          ? () => (
              <View style={{ width: SWIPE_MAX }}>
                <SwipeStrip side="left" icon={left.icon} label={left.label} dark={props.dark} />
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
  const preview = props.nested
    ? ""
    : row.kind === "ask"
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

  // Left swipe archives in the Done drawer too; Snoozed rows wake from their menu.
  const swipeLeft = props.nested || (props.drawer && row.kind !== "finished") ? null : archiveRow;
  const swipeRight =
    props.nested || props.drawer || !snoozable
      ? null
      : () => openSnoozeSheet(gt, context, row, title);

  const menuActions = [
    ...(row.snoozedUntil !== null
      ? [{ id: "unsnooze", title: gt("Unsnooze"), image: "moon.zzz" }]
      : []),
    ...(asks ? [{ id: "answered", title: gt("Mark answered"), image: "checkmark.circle" }] : []),
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
              image: "moon",
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
      void answerAsk(context.target, row.ask.askNo, PM_ANSWERED_IN_CHAT);
    else if (event === "answered" && row.kind === "page")
      void replyToPage(context.target, row.page.pageId, PM_ANSWERED_IN_CHAT);
    else if (event === "archive") archiveRow?.();
    else if (event.startsWith("snooze:"))
      void snoozeRow(context.target, row, Number(event.slice("snooze:".length)));
    else if (event === "markdown") void Clipboard.setStringAsync(pmInboxMarkdown(row));
    else if (event === "mention" && row.kind === "ask")
      mentionInComposer(context.draftKey, pmAskTag(row.ask));
  };

  const buttons: Array<ReactNode> = [];
  if (props.nested || row.kind === "finished") {
    // A finished row's Archive sits in its age slot; a bundle's page has no buttons.
  } else if (row.kind === "pages") {
    buttons.push(
      <QuietButton key="expand" onPress={() => setExpanded(!expanded)}>
        {expanded ? gt("Collapse") : gt("Expand")}
      </QuietButton>,
    );
  } else {
    if (!asks && archiveRow)
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
      // Ghostex keeps the answers on the row and a quiet Details beside them; answers too wide
      // for the phone wait behind Details, in the ask's sheet.
      const fits = answers.length <= 2 && answers.join("").length <= (row.details ? 10 : 18);
      if (fits)
        for (const answer of answers)
          buttons.push(
            <TextButton
              key={answer}
              onPress={() => void answerAsk(context.target, row.ask.askNo, answer)}
            >
              <View className="flex-row items-center gap-1">
                {answer === row.ask.recommended ? (
                  <IconStarFilled size={10} color="#f5b301" />
                ) : null}
                <Text className="text-sm text-foreground">{answer}</Text>
              </View>
            </TextButton>,
          );
      if (row.details || !fits)
        buttons.push(
          <Pressable
            key="details"
            accessibilityRole="button"
            hitSlop={4}
            className="h-[28px] items-center justify-center rounded-lg border border-border bg-subtle px-[11px]"
            onPress={() => openAsk(row.ask.askNo)}
          >
            <Text className="text-sm text-foreground-muted">{gt("Details")}</Text>
          </Pressable>,
        );
    }
    if (row.kind === "page")
      buttons.push(
        <IconPress
          key="open"
          icon={IconExternalLink}
          label={gt("Open page")}
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
      ? gt("back in {age}", {
          age: ageLabel(gt, new Date(context.now).toISOString(), Date.parse(row.snoozedUntil)),
          $context: "When a snoozed Inbox row comes back",
        })
      : ageLabel(gt, row.at, context.now);

  return (
    <View className={cn(props.nested && "ml-[22px] border-l-2 border-border pl-1")}>
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
        dark={context.dark}
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
              <MarkIcon size={props.nested ? 12 : 14} color={markColor} />
              <Text
                className={cn(
                  "flex-1 text-sm",
                  row.unread ? "text-foreground" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {title}
              </Text>
              {buttons.length > 0 ? (
                <View className="flex-row items-center gap-1.5">{buttons}</View>
              ) : null}
              <View className="min-w-[26px] flex-row items-center justify-end gap-1">
                <Text className="text-sm text-foreground-muted">{age}</Text>
                {props.nested ? null : row.kind === "finished" && archiveRow ? (
                  <IconPress
                    icon={IconCheck}
                    label={gt("Archive")}
                    color={context.muted}
                    onPress={archiveRow}
                  />
                ) : (
                  <Menu
                    accessibilityLabel={gt("More actions")}
                    actions={menuActions}
                    onPressAction={({ nativeEvent }) => onMenu(nativeEvent.event)}
                  >
                    <View className="size-[28px] items-center justify-center">
                      <IconDots size={14} color={context.muted} />
                    </View>
                  </Menu>
                )}
              </View>
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
