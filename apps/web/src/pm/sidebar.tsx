import type { EnvironmentId, PmSummary, ProjectId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  BriefcaseIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams, isThreadRoutePathname } from "../threadRoutes";
import { formatRelativeTime } from "../timestampFormat";
import { createPmAndOpen } from "./actions";
import { type PmWorkerDot, pmDotStack, pmFirst, pmWorkerDot } from "@t3tools/pm/client";
import { pmKey, usePmIndex } from "./state";
import { PmNotMovingChip } from "./notMovingChip";

type SidebarThread = Pick<EnvironmentThreadShell, "environmentId" | "id">;

const summaryOf = (index: ReturnType<typeof usePmIndex>, thread: SidebarThread) =>
  index.pms.get(pmKey(thread.environmentId, thread.id)) ?? null;

/** Grouped mode keeps PMs first in their project folder. */
export function usePmFirst() {
  const index = usePmIndex();
  return <T extends SidebarThread>(threads: ReadonlyArray<T>): Array<T> => [
    ...pmFirst(threads, (thread) => index.pms.has(pmKey(thread.environmentId, thread.id))),
  ];
}

function PmBadge(props: { readonly className?: string }) {
  const gt = useGT();
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm border border-border/80 px-1 font-medium text-3xs text-muted-foreground uppercase leading-none tracking-wide",
        props.className,
      )}
    >
      {gt("PM", { $context: "badge for a project manager thread" })}
    </span>
  );
}

function PmCounts(props: { readonly summary: PmSummary }) {
  const gt = useGT();
  const { summary } = props;
  return (
    <span className="flex min-w-0 items-center gap-2 truncate text-2xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <ListChecksIcon aria-hidden className="size-3" />
        {gt("{count, plural, one {# item} other {# items}}", { count: summary.openItems })}
      </span>
      <span className="inline-flex items-center gap-1">
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {gt("{count, plural, one {# ask} other {# asks}}", { count: summary.openAsks })}
      </span>
      <span className="inline-flex items-center gap-1">
        <UsersRoundIcon aria-hidden className="size-3" />
        {gt("{count, plural, one {# worker} other {# workers}}", { count: summary.workers })}
      </span>
    </span>
  );
}

type TopStatus = {
  readonly label: string;
  readonly icon: "working" | "input" | "failed";
  readonly className: string;
};

/**
 * What a PM row shows instead of a plain thread's: a PM badge after the project name, the counts
 * line, and the PM's state in the status slot while its own turn is not running.
 */
export function usePmRow(thread: SidebarThread, status: string) {
  const gt = useGT();
  const summary = summaryOf(usePmIndex(), thread);
  if (summary === null) return null;
  const ownTurn = status === "working" || status === "preparing";
  const topStatus: TopStatus | null = ownTurn
    ? null
    : summary.rowState === "blocked"
      ? {
          label: gt("Blocked", { $context: "PM status" }),
          icon: "failed",
          className: "text-error-foreground",
        }
      : summary.rowState === "needs_you"
        ? {
            label: gt("Needs you", { $context: "PM status" }),
            icon: "input",
            className: "text-warning-foreground",
          }
        : summary.rowState === "running"
          ? {
              label: gt("{count} running", {
                count: summary.runningWorkers,
                $context: "PM status",
              }),
              icon: "working",
              className: "text-info-foreground",
            }
          : null;
  return {
    badge: <PmBadge className="ms-1.5 align-[1px]" />,
    meta: (
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
        <PmCounts summary={summary} />
      </div>
    ),
    topStatus,
  };
}

/** The mission and the counts spelled out, first in the row's hover card. */
export function PmHoverRows(props: { readonly thread: SidebarThread }) {
  const gt = useGT();
  const summary = summaryOf(usePmIndex(), props.thread);
  if (summary === null) return null;
  return (
    <>
      {summary.mission.length > 0 ? (
        <div className="flex min-w-0 items-start gap-2">
          <BriefcaseIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <div className="min-w-0 text-foreground/75">{summary.mission}</div>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <ListChecksIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 truncate text-foreground/75">
          {gt(
            "{items, plural, one {# open work item} other {# open work items}} · {asks, plural, one {# ask} other {# asks}} · {workers, plural, one {# worker} other {# workers}} ({running} running)",
            {
              items: summary.openItems,
              asks: summary.openAsks,
              workers: summary.workers,
              running: summary.runningWorkers,
            },
          )}
        </div>
      </div>
    </>
  );
}

function workerStatus(
  shell: EnvironmentThreadShell,
  gt: ReturnType<typeof useGT>,
): { readonly label: string; readonly className: string } {
  if (shell.hasPendingApprovals)
    return {
      label: gt("Approval", { $context: "thread status: needs approval" }),
      className: "text-warning-foreground",
    };
  if (shell.hasPendingUserInput)
    return {
      label: gt("Input", { $context: "thread status: needs user input" }),
      className: "text-indigo-600 dark:text-indigo-300",
    };
  if (threadRuntimeIsActive(shell.runtime))
    return {
      label: gt("Working", { $context: "thread status" }),
      className: "text-info-foreground",
    };
  return {
    label: formatRelativeTime(shell.updatedAt)?.value ?? "",
    className: "text-muted-foreground",
  };
}

// Ghostex's status colours: red blocker, pink question, blue finished, amber working, grey.
const DOT_COLOR: Record<PmWorkerDot, string> = {
  blocker: "bg-[#f87171]",
  question: "bg-[#f472b6]",
  finished: "bg-[#95d7f6]",
  working: "bg-[#f5a524]",
  idle: "bg-muted-foreground/50",
};

/** A folded PM's workers as one overlapping stack, the most urgent dot on top. */
function PmDotStack(props: { readonly dots: ReadonlyArray<PmWorkerDot> }) {
  return (
    <span aria-hidden className="ms-auto flex items-center">
      {props.dots.map((dot, index) => (
        <span
          key={dot}
          className={cn(
            "size-2 rounded-full ring-2 ring-sidebar",
            DOT_COLOR[dot],
            index > 0 && "-ms-1",
          )}
        />
      ))}
    </span>
  );
}

const foldedPms = new Set<string>();

/** A PM's workers, nested under its row; one call per sidebar row, nothing for other threads. */
export const pmWorkerRows = (pm: SidebarThread) => (
  <PmWorkerRows key={`pm-workers:${pmKey(pm.environmentId, pm.id)}`} pm={pm} />
);

/** A PM's workers, nested under its row as one-line rows that fold with it. */
function PmWorkerRows(props: { readonly pm: SidebarThread }) {
  const summary = summaryOf(usePmIndex(), props.pm);
  if (summary === null || summary.workerThreadIds.length === 0) return null;
  return <PmWorkerList pm={props.pm} />;
}

function PmWorkerList(props: { readonly pm: SidebarThread }) {
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const index = usePmIndex();
  const shells = useThreadShells();
  const key = pmKey(props.pm.environmentId, props.pm.id);
  const [folded, setFolded] = useState(() => foldedPms.has(key));
  const summary = index.pms.get(key);
  if (summary === undefined || summary.workerThreadIds.length === 0) return null;
  const workers = summary.workerThreadIds
    .map((threadId) =>
      shells.find(
        (shell) => shell.environmentId === props.pm.environmentId && shell.id === threadId,
      ),
    )
    .filter(
      (shell): shell is EnvironmentThreadShell => shell !== undefined && shell.archivedAt === null,
    );
  if (workers.length === 0) return null;
  const notMoving = new Set<string>(summary.notMovingWorkerThreadIds ?? []);
  const toggle = () => {
    if (folded) foldedPms.delete(key);
    else foldedPms.add(key);
    setFolded(!folded);
    // As in Ghostex: folding away the open worker opens its PM, so the open chat stays in view.
    const pathname = router.state.location.pathname;
    if (
      !folded &&
      workers.some((worker) =>
        isThreadRoutePathname(pathname, scopeThreadRef(worker.environmentId, worker.id)),
      )
    )
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(props.pm.environmentId, props.pm.id)),
      });
  };
  return (
    <div className="ms-3 border-border/60 border-s ps-1" data-pm-workers={key}>
      <button
        type="button"
        className="flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-accent"
        aria-expanded={!folded}
        onClick={toggle}
      >
        {folded ? (
          <ChevronRightIcon aria-hidden className="size-3" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-3" />
        )}
        <UsersRoundIcon aria-hidden className="size-3 text-primary/80" />
        {gt("{count, plural, one {# worker} other {# workers}}", { count: workers.length })}
        {folded ? (
          <PmDotStack
            dots={pmDotStack(
              // As in Ghostex, a worker not moving after its nudge is the red dot.
              workers.map((worker) => (notMoving.has(worker.id) ? "blocker" : pmWorkerDot(worker))),
            )}
          />
        ) : null}
      </button>
      {folded
        ? null
        : workers.map((worker) => {
            const status = workerStatus(worker, gt);
            const ref = scopeThreadRef(worker.environmentId, worker.id);
            return (
              <button
                key={worker.id}
                type="button"
                data-sidebar-row={pmKey(worker.environmentId, worker.id)}
                data-sidebar-parent={key}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground/90 hover:bg-accent"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(ref),
                  })
                }
              >
                <span className="min-w-0 flex-1 truncate">{worker.title}</span>
                {notMoving.has(worker.id) ? (
                  <PmNotMovingChip />
                ) : (
                  <span className={cn("shrink-0 text-2xs", status.className)}>{status.label}</span>
                )}
              </button>
            );
          })}
    </div>
  );
}

/** The folder header's hover button, left of New thread. */
export function PmNewButton(props: {
  readonly group: {
    readonly environmentId: EnvironmentId;
    readonly displayName: string;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly environmentId: EnvironmentId;
    }>;
  };
  readonly rowId: string;
}): ReactNode {
  const gt = useGT();
  const navigate = useNavigate();
  const enabled = usePmIndex().enabled.has(props.group.environmentId);
  const project = props.group.memberProjectRefs.find(
    (ref) => ref.environmentId === props.group.environmentId,
  );
  if (!enabled || project === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-sidebar-action-for={props.rowId}
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("New PM in {project}", { project: props.group.displayName })}
            onClick={() =>
              void createPmAndOpen({
                environmentId: project.environmentId,
                projectId: project.projectId,
                navigate,
              })
            }
          />
        }
      >
        <BriefcaseIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {gt("New PM in {project}", { project: props.group.displayName })}
      </TooltipPopup>
    </Tooltip>
  );
}

export { handlePmFolderMenuAction, pmFolderMenuItems } from "./entryPoints";
export { handlePmThreadAction, pmMenuState } from "./menuBridge";

/** The PM badge on an archived PM in Settings, Archived threads. */
function PmArchivedBadge(props: { readonly thread: SidebarThread }) {
  return summaryOf(usePmIndex(), props.thread) === null ? null : (
    <PmBadge className="ms-1.5 align-[1px]" />
  );
}

/** Settings, Archived threads: the title with the PM badge for an archived PM. */
export const pmArchivedTitle = (thread: SidebarThread & { readonly title: string }) => (
  <>
    {thread.title}
    <PmArchivedBadge thread={thread} />
  </>
);
