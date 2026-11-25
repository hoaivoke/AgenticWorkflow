import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  PmRemoteWorkerSummary,
  PmWorkerComputer,
  ThreadId,
} from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { pmKey } from "@t3tools/pm/client";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { cn } from "../lib/cn";
import { useOpenLinkedThreadRead } from "../features/threads/useOpenLinkedThread";
import { useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { convertToPm, createPm, revertPm } from "./actions";
import { PmNotMovingChip } from "./notMovingChip";
import { pmWorkerPreview } from "./pm.logic";
import { usePmIndex, usePmSummary } from "./state";

type RowThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId">;

/** The "PM" badge on a project manager's row. */
export function PmRowBadge(props: { readonly thread: RowThread }) {
  const gt = useGT();
  if (usePmSummary(props.thread.environmentId, props.thread.id) === null) return null;
  return (
    <View className="rounded border border-border px-1">
      <Text className="font-t3-medium text-3xs uppercase text-foreground-muted">
        {gt("PM", { $context: "badge for a project manager thread" })}
      </Text>
    </View>
  );
}

/** Under a PM's title: its counts and status, then its workers, two at most, then "N more". */
export function PmRowCounts(props: {
  readonly thread: RowThread;
  readonly inset: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const gt = useGT();
  const summary = usePmSummary(props.thread.environmentId, props.thread.id);
  const shells = useThreadShells();
  if (summary === null) return null;
  const workerKeys = new Set(
    summary.workerThreadIds.map((id) => pmKey(props.thread.environmentId, id)),
  );
  type Entry =
    | { readonly kind: "here"; readonly shell: EnvironmentThreadShell }
    | { readonly kind: "remote"; readonly worker: PmRemoteWorkerSummary };
  const workers: ReadonlyArray<Entry> = [
    ...shells
      .filter((shell) => workerKeys.has(pmKey(shell.environmentId, shell.id)))
      .map((shell) => ({ kind: "here" as const, shell })),
    // t3code-pm: workers on the user's other computers, carried by the summary.
    ...(summary.remoteWorkers ?? []).map((worker) => ({ kind: "remote" as const, worker })),
  ];
  const preview = pmWorkerPreview(workers, (entry) =>
    entry.kind === "here"
      ? threadRuntimeIsActive(entry.shell.runtime)
      : entry.worker.state === "running",
  );
  const notMoving = new Set<string>(summary.notMovingWorkerThreadIds ?? []);
  const status =
    summary.rowState === "blocked"
      ? { text: gt("Blocked"), className: "text-danger-foreground" }
      : summary.rowState === "needs_you"
        ? { text: gt("Needs you"), className: "text-warning-foreground" }
        : summary.rowState === "running"
          ? {
              text: gt("{count} running", { count: summary.runningWorkers }),
              className: "text-primary-text",
            }
          : { text: gt("Idle"), className: "text-foreground-muted" };
  return (
    <View className="mt-1 gap-1.5" style={{ paddingLeft: props.inset }}>
      <View className="flex-row items-center gap-3">
        <Count
          icon="list.number"
          text={gt("{count, plural, one {# item} other {# items}}", { count: summary.openItems })}
        />
        <Count
          icon="questionmark.bubble"
          text={gt("{count, plural, one {# ask} other {# asks}}", { count: summary.openAsks })}
        />
        <Count
          icon="robot"
          text={gt("{count, plural, one {# worker} other {# workers}}", { count: summary.workers })}
        />
        <Text className={cn("ml-auto text-xs font-t3-medium", status.className)}>
          {status.text}
        </Text>
      </View>
      {preview.shown.map((entry) =>
        entry.kind === "remote" ? (
          <PmRemoteWorkerRow
            key={entry.worker.threadId}
            viaEnvironmentId={props.thread.environmentId}
            worker={entry.worker}
          />
        ) : (
          <Pressable
            key={entry.shell.id}
            accessibilityRole="button"
            accessibilityLabel={gt("Open worker {title}", { title: entry.shell.title })}
            className="flex-row items-center gap-2 py-1"
            onPress={() => props.onSelectThread(entry.shell)}
          >
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {entry.shell.title}
            </Text>
            {notMoving.has(entry.shell.id) ? (
              <PmNotMovingChip />
            ) : threadRuntimeIsActive(entry.shell.runtime) ? (
              <Text className="text-xs text-primary-text">{gt("Working")}</Text>
            ) : null}
          </Pressable>
        ),
      )}
      {preview.more > 0 ? (
        <Text className="text-xs text-foreground-muted">
          {gt("{count} more", { count: preview.more })}
        </Text>
      ) : null}
    </View>
  );
}

/** Opens a worker on another computer: in place when this app is connected there, else read-only. */
export function useOpenRemoteWorker() {
  const navigation = useNavigation();
  const openLinkedRead = useOpenLinkedThreadRead();
  const { presentationById } = useEnvironments();
  return (
    viaEnvironmentId: EnvironmentId,
    worker: {
      readonly threadId: ThreadId;
      readonly title: string | null;
      readonly computer: PmWorkerComputer;
    },
  ) => {
    const { computer } = worker;
    const target = { environmentId: computer.environmentId, threadId: worker.threadId };
    if (presentationById.get(computer.environmentId)?.connection.phase === "connected")
      navigation.dispatch(StackActions.push("Thread", target));
    else openLinkedRead(target, { viaEnvironmentId, label: computer.label }, worker.title);
  };
}

/** A worker on another computer: always named with its computer, red while it can't be reached. */
function PmRemoteWorkerRow(props: {
  readonly viaEnvironmentId: EnvironmentId;
  readonly worker: PmRemoteWorkerSummary;
}) {
  const gt = useGT();
  const openRemote = useOpenRemoteWorker();
  const { worker } = props;
  const { computer } = worker;
  const off = computer.lost !== null || computer.unreachableSince !== null;
  const open = () => openRemote(props.viaEnvironmentId, worker);
  const status =
    computer.lost !== null
      ? gt("Lost", { $context: "worker status: its computer's link is gone" })
      : computer.unreachableSince !== null
        ? gt("Unreachable", { $context: "worker status: its computer does not answer" })
        : worker.state === "running"
          ? gt("Working")
          : worker.state === "waiting"
            ? gt("Waiting", { $context: "worker status: waits for an answer" })
            : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Open worker {title} on {computer}", {
        title: worker.title,
        computer: computer.label,
      })}
      className="flex-row items-center gap-2 py-1"
      onPress={open}
    >
      <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
        {worker.title}
      </Text>
      <View className="max-w-[45%] flex-row items-center gap-1">
        <SymbolView
          name="desktopcomputer"
          size={11}
          tintColorClassName={off ? "accent-danger-foreground" : "accent-foreground-muted"}
        />
        <Text
          className={cn("text-xs", off ? "text-danger-foreground" : "text-foreground-muted")}
          numberOfLines={1}
        >
          {computer.label}
        </Text>
      </View>
      {status === null ? null : (
        <Text
          className={cn(
            "text-xs",
            off
              ? "text-danger-foreground"
              : worker.state === "running"
                ? "text-primary-text"
                : "text-warning-foreground",
          )}
        >
          {status}
        </Text>
      )}
    </Pressable>
  );
}

function Count(props: {
  readonly icon: "list.number" | "questionmark.bubble" | "robot";
  readonly text: string;
}) {
  return (
    <View className="flex-row items-center gap-1">
      <SymbolView name={props.icon} size={11} tintColorClassName="accent-foreground-muted" />
      <Text className="text-xs text-foreground-muted">{props.text}</Text>
    </View>
  );
}

/**
 * A row's long-press additions: a PM shows its mission first (mobile has no preview to carry it),
 * then the way in or out of being a PM, and every row in an environment with PMs on offers a new
 * PM in its project.
 */
export function usePmRowMenu(thread: RowThread) {
  const gt = useGT();
  const index = usePmIndex();
  const navigation = useNavigation();
  const key = pmKey(thread.environmentId, thread.id);
  const summary = index.pms.get(key) ?? null;
  const role: MenuAction[] =
    summary !== null
      ? [
          {
            id: "pm-revert",
            title: gt("Turn back into a normal thread"),
            image: "arrow.uturn.backward",
            attributes: { disabled: summary.runningWorkers > 0 },
          },
        ]
      : index.workerOf.has(key)
        ? []
        : [{ id: "pm-make", title: gt("Make this a PM"), image: "briefcase" }];
  const actions: MenuAction[] = index.enabled.has(thread.environmentId)
    ? [
        ...(summary === null
          ? []
          : [
              {
                id: "pm-mission",
                title: summary.mission.trim() || gt("No mission yet"),
                image: "target",
                attributes: { disabled: true },
              },
            ]),
        ...role,
        { id: "pm-new", title: gt("New PM in this project"), image: "briefcase" },
      ]
    : [];
  const handle = (event: string) => {
    if (event === "pm-make") {
      void convertToPm(thread.environmentId, thread.id);
      return true;
    }
    if (event === "pm-revert") {
      void revertPm(thread.environmentId, thread.id);
      return true;
    }
    if (event !== "pm-new") return false;
    void createPm(thread.environmentId, thread.projectId, (target) =>
      navigation.dispatch(StackActions.push("Thread", target)),
    );
    return true;
  };
  return { actions, handle };
}
