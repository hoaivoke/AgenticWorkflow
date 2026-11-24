import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  PM_INBOX_LIMIT,
  PM_INBOX_PHONE_LIMIT,
  type PmInbox,
  type PmInboxAnswered,
  pmInbox,
  pmInboxHidden,
  type PmInboxRow,
} from "@t3tools/pm/client";
import { useGT } from "gt-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { useEnvironmentScope } from "../state/session";
import {
  archive,
  archiveDone,
  focusComposer,
  type InboxTarget,
  type InboxUndo,
  openWorkGroup,
  showMessageInChat,
} from "./inboxActions";
import { InboxIcon, type InboxGlyph } from "./inboxIcons";
import {
  AMBER,
  CountBadge,
  GREEN,
  InboxRowView,
  PINK,
  RED,
  type RowContext,
  type RowMenuRequest,
  rowArchive,
  TextButton,
  useAgeLabel,
} from "./inboxRow";
import { PmMissionDialog } from "./mission";
import { pmKey, usePmSummary, usePmThreadDetail } from "./state";
import { usePmFold } from "./uiState";

interface DockProps {
  readonly threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  /** Upstream's blocking question drawer is showing; the Inbox steps aside. */
  readonly hidden?: boolean;
}

/** The Inbox above a PM's composer: Ghostex's Session Inbox over the PM's asks, pages and work. */
export function PmComposerDock(props: DockProps) {
  const summary = usePmSummary(
    props.threadRef?.environmentId ?? null,
    props.threadRef?.threadId ?? null,
  );
  if (props.threadRef === null || summary === null) return null;
  return (
    <>
      <PmMissionDialog threadRef={props.threadRef} />
      {props.hidden ? null : <PmInboxCard target={props.threadRef} />}
    </>
  );
}

function PmInboxCard(props: { readonly target: InboxTarget }) {
  const { environmentId, threadId } = props.target;
  const detail = usePmThreadDetail(environmentId, threadId);
  // The tick is UTC `YYYY-MM-DDTHH:mm`; without the zone Date.parse would read it as local time.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  if (detail === null) return null;
  const inbox = pmInbox(detail, now);
  const empty =
    inbox.rows.length === 0 &&
    inbox.done.length === 0 &&
    inbox.snoozed.length === 0 &&
    inbox.answered.length === 0 &&
    inbox.counts.inProgress === 0;
  if (empty) return null;
  return <InboxSurface target={props.target} inbox={inbox} now={now} />;
}

function InboxSurface(props: {
  readonly target: InboxTarget;
  readonly inbox: PmInbox;
  readonly now: number;
}) {
  const gt = useGT();
  const { target, inbox, now } = props;
  const key = pmKey(target.environmentId, target.threadId);
  const canOperate = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const phone = useMediaQuery("max-sm");
  const [folded, setFolded] = usePmFold(`dock:${key}`, false);
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const [undo, setUndo] = useState<(InboxUndo & { readonly id: number }) | null>(null);
  const limit = phone ? PM_INBOX_PHONE_LIMIT : PM_INBOX_LIMIT;
  const shown = showAll ? inbox.rows : inbox.rows.slice(0, limit);
  const hidden = pmInboxHidden(inbox.rows.slice(limit));
  const focusAt = Math.min(focus, shown.length - 1);

  const onUndo = (next: InboxUndo | null) => {
    if (next === null) return;
    const id = Date.now();
    setUndo({ ...next, id });
    setTimeout(() => setUndo((current) => (current?.id === id ? null : current)), 8000);
  };
  const context: RowContext = {
    target,
    canOperate,
    now,
    phone,
    cwd: undefined,
    menu,
    onMenu: setMenu,
    onUndo,
  };

  // Ghostex's Inbox keys: Up and Down move, Enter opens, E archives or dismisses, S snoozes, Esc
  // goes back to the chat box.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const row: PmInboxRow | undefined = shown[focusAt];
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          setFocus(Math.min(shown.length - 1, focusAt + 1));
          return true;
        case "ArrowUp":
          setFocus(Math.max(0, focusAt - 1));
          return true;
        case "Enter":
          if (row)
            event.currentTarget
              .querySelector<HTMLElement>(`[data-pm-inbox-row="${CSS.escape(row.key)}"]`)
              ?.click();
          return true;
        case "e":
        case "E":
          if (row && canOperate) rowArchive(context, row)?.();
          return true;
        case "s":
        case "S":
          if (row && canOperate && (row.kind === "ask" || row.kind === "page"))
            setMenu({ key: row.key, mode: "snooze", at: null });
          return true;
        case "Escape":
          setFocus(-1);
          focusComposer();
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  const moreParts = [
    hidden.pings > 0
      ? gt("{count, plural, one {# more ping} other {# more pings}}", { count: hidden.pings })
      : null,
    hidden.blocked > 0 ? gt("{count} more blocked", { count: hidden.blocked }) : null,
    hidden.done > 0 ? gt("{count} more done", { count: hidden.done }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <section
      data-pm-inbox=""
      aria-label={gt("Inbox")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && focus < 0 && shown.length > 0) setFocus(0);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(-1);
      }}
      className="mb-2 overflow-hidden rounded-xl border border-border bg-card text-foreground text-sm outline-none"
    >
      <InboxHeader
        target={target}
        inbox={inbox}
        folded={folded}
        onFold={() => setFolded(!folded)}
      />
      {folded ? null : (
        <>
          {shown.length > 0 ? (
            <div role="list" className="max-h-[min(360px,40vh)] overflow-y-auto p-1">
              {shown.map((row, index) => (
                <InboxRowView
                  key={row.key}
                  row={row}
                  context={context}
                  focused={index === focusAt}
                />
              ))}
              {moreParts.length > 0 && !showAll ? (
                <MoreLine onClick={() => setShowAll(true)}>{moreParts.join(" · ")}</MoreLine>
              ) : null}
              {showAll && inbox.rows.length > limit ? (
                <MoreLine onClick={() => setShowAll(false)}>{gt("Show fewer")}</MoreLine>
              ) : null}
            </div>
          ) : null}
          {inbox.archiveAll && canOperate ? (
            <ArchiveAllFooter
              archiveAll={inbox.archiveAll}
              onArchive={() => void archive(target, inbox.archiveAll ?? {}).then(onUndo)}
            />
          ) : null}
          {undo ? (
            <div className="flex h-9 items-center gap-2 border-border/60 border-t ps-3 pe-1.25 pm-inbox-text">
              <InboxIcon name="archive" className="size-[15px] text-muted-foreground" />
              <span className="flex-1 text-muted-foreground">
                {gt("Archived {count}", { count: undo.count })}
              </span>
              <TextButton
                onClick={() => {
                  setUndo(null);
                  void undo.undo();
                }}
              >
                {gt("Undo")}
              </TextButton>
              <button
                type="button"
                aria-label={gt("Close")}
                onClick={() => setUndo(null)}
                className="inline-flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              >
                <InboxIcon name="x" className="size-[15px]" />
              </button>
            </div>
          ) : null}
          {inbox.done.length > 0 ? (
            <Drawer
              foldKey={`dock-done:${key}`}
              icon="circleCheck"
              iconClassName={GREEN}
              label={gt("Done", { $context: "Inbox drawer of finished work" })}
              count={inbox.done.length}
              action={
                inbox.done.length >= 2 && canOperate ? (
                  <TextButton
                    onClick={() =>
                      void archiveDone(
                        target,
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
                <InboxRowView key={row.key} row={row} context={context} drawer />
              ))}
            </Drawer>
          ) : null}
          {inbox.snoozed.length > 0 ? (
            <Drawer
              foldKey={`dock-snoozed:${key}`}
              icon="moon"
              iconClassName="text-muted-foreground"
              label={gt("Snoozed")}
              count={inbox.snoozed.length}
            >
              {inbox.snoozed.map((row) => (
                <InboxRowView key={row.key} row={row} context={context} drawer />
              ))}
            </Drawer>
          ) : null}
          {inbox.answered.length > 0 ? (
            <Drawer
              foldKey={`dock-answered:${key}`}
              icon="messageCheck"
              iconClassName={GREEN}
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
    </section>
  );
}

function InboxHeader(props: {
  readonly target: InboxTarget;
  readonly inbox: PmInbox;
  readonly folded: boolean;
  readonly onFold: () => void;
}) {
  const gt = useGT();
  const { counts } = props.inbox;
  return (
    <div
      onClick={props.onFold}
      className={cn(
        "flex h-[34px] min-w-0 cursor-default items-center gap-3 overflow-hidden ps-3 pe-1.25 pm-inbox-text max-sm:gap-2",
        !props.folded && "rounded-t-xl border-border/60 border-b bg-foreground/[3.5%]",
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <InboxIcon name="inbox" className="size-[15px] text-muted-foreground" />
        {gt("Inbox")}
      </span>
      {counts.pings > 0 ? (
        <CountChip
          icon="circleDot"
          className={PINK}
          tooltip={gt("Open Pings in Work")}
          onClick={() => openWorkGroup(props.target, "needs_you")}
        >
          {gt("{count, plural, one {# ping} other {# pings}}", { count: counts.pings })}
        </CountChip>
      ) : null}
      {counts.blocked > 0 ? (
        <CountChip
          icon="circleMinusFilled"
          className={RED}
          tooltip={gt("Open Blocked in Work")}
          onClick={() => openWorkGroup(props.target, "blocked")}
        >
          {gt("{count} blocked", { count: counts.blocked, $context: "Inbox count" })}
        </CountChip>
      ) : null}
      {counts.inProgress > 0 ? (
        <CountChip
          icon="circleHalf"
          className={AMBER}
          tooltip={gt("Open In progress in Work")}
          onClick={() => openWorkGroup(props.target, "in_progress")}
        >
          {gt("{count} in progress", { count: counts.inProgress, $context: "Inbox count" })}
        </CountChip>
      ) : null}
      <span className="flex-1" />
      <button
        type="button"
        aria-expanded={!props.folded}
        aria-label={props.folded ? gt("Show the Inbox") : gt("Fold the Inbox")}
        onClick={(event) => {
          event.stopPropagation();
          props.onFold();
        }}
        className="inline-flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
      >
        <InboxIcon
          name="chevronDown"
          className={cn("size-[15px] transition-transform", props.folded && "rotate-180")}
        />
      </button>
    </div>
  );
}

function CountChip(props: {
  readonly icon: InboxGlyph;
  readonly className: string;
  readonly tooltip: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
            className="inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 text-foreground/80 hover:bg-foreground/8 hover:text-foreground"
          />
        }
      >
        <InboxIcon name={props.icon} className={cn("size-[13px]", props.className)} />
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function MoreLine(props: { readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="block w-full truncate rounded-lg py-1 ps-7.75 pe-2 text-start pm-inbox-text text-muted-foreground hover:bg-foreground/4 hover:text-foreground"
    >
      {props.children}
    </button>
  );
}

function ArchiveAllFooter(props: {
  readonly archiveAll: NonNullable<PmInbox["archiveAll"]>;
  readonly onArchive: () => void;
}) {
  const gt = useGT();
  const pages = props.archiveAll.pageIds.length;
  const todos = props.archiveAll.askNos.length;
  const summary = [
    pages > 0 ? gt("{count, plural, one {# page} other {# pages}}", { count: pages }) : null,
    todos > 0 ? gt("{count, plural, one {# to-do} other {# to-dos}}", { count: todos }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex h-9 items-center gap-2 border-border/60 border-t ps-3 pe-1.25 pm-inbox-text">
      <span className="flex-1 truncate text-muted-foreground">{summary}</span>
      <TextButton onClick={props.onArchive}>
        <InboxIcon name="check" className="size-3.5" />
        {gt("Archive all")}
        <CountBadge count={pages + todos} />
      </TextButton>
    </div>
  );
}

function Drawer(props: {
  readonly foldKey: string;
  readonly icon: InboxGlyph;
  readonly iconClassName: string;
  readonly label: string;
  readonly count: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = usePmFold(props.foldKey, false);
  return (
    <div className="border-border/60 border-t">
      <div className="flex h-8 items-center gap-2 ps-3 pe-1.25">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pm-inbox-text text-muted-foreground hover:text-foreground"
        >
          <InboxIcon name={props.icon} className={cn("size-[13px]", props.iconClassName)} />
          <span>{props.label}</span>
          <CountBadge count={props.count} />
          <InboxIcon
            name="chevronDown"
            className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
          />
        </button>
        {open ? props.action : null}
      </div>
      {open ? <div className="px-1 pb-1">{props.children}</div> : null}
    </div>
  );
}

function AnsweredRow(props: { readonly row: PmInboxAnswered; readonly now: number }) {
  const gt = useGT();
  const age = useAgeLabel();
  const { row } = props;
  return (
    <button
      type="button"
      onClick={() => {
        if (row.messageId === null || !showMessageInChat(row.messageId))
          toastManager.add({ type: "info", title: gt("That message is not loaded") });
      }}
      className="flex w-full items-center gap-2 rounded-lg py-1.5 ps-6 pe-2 text-start opacity-72 hover:bg-foreground/4"
    >
      <span className="pm-inbox-title min-w-0 flex-1 truncate text-muted-foreground">
        {row.title}
      </span>
      {row.outcome ? (
        <span className="max-w-[40%] shrink-0 truncate pm-inbox-outcome rounded-full px-2 text-xs leading-5">
          {row.outcome}
        </span>
      ) : null}
      <span className="min-w-[26px] shrink-0 text-end text-muted-foreground text-xs tabular-nums">
        {age(row.at, props.now)}
      </span>
    </button>
  );
}
