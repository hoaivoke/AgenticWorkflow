import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  PM_INBOX_LIMIT,
  PM_INBOX_PHONE_LIMIT,
  type PmInbox,
  type PmInboxHandled,
  pmInbox,
  pmInboxHidden,
  type PmInboxRow,
} from "@t3tools/pm/client";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { shortcutLabelForCommand } from "../keybindings";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import {
  archive,
  archiveRecent,
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
  QuietButton,
  RED,
  type RowContext,
  type RowMenuRequest,
  rowArchive,
  useAgeLabel,
} from "./inboxRow";
import { PmMissionDialog } from "./mission";
import { pmKey, usePmSummary, usePmThreadDetail } from "./state";
import { setPmDockHidden, usePmDockHidden, usePmFold, usePmRecentArchived } from "./uiState";

interface DockProps {
  readonly threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  /** Upstream's blocking question drawer is showing; the Inbox steps aside. */
  readonly hidden?: boolean;
  /** Ghostex folds the dock away past 280 characters of draft (`DOCK_FOLDS_PAST_CHARS`). */
  readonly longDraft?: boolean;
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
      {props.hidden || props.longDraft ? null : <PmInboxCard target={props.threadRef} />}
    </>
  );
}

function PmInboxCard(props: { readonly target: InboxTarget }) {
  const { environmentId, threadId } = props.target;
  const detail = usePmThreadDetail(environmentId, threadId);
  const archived = usePmRecentArchived(pmKey(environmentId, threadId));
  // The tick is UTC `YYYY-MM-DDTHH:mm`; without the zone Date.parse would read it as local time.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  if (detail === null) return null;
  return <InboxSurface target={props.target} inbox={pmInbox(detail, now, archived)} now={now} />;
}

const UNDO_MS = 10_000;

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
  const hiddenRows = usePmDockHidden(key);
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const [undo, setUndo] = useState<(InboxUndo & { readonly id: number }) | null>(null);
  const limit = phone ? PM_INBOX_PHONE_LIMIT : PM_INBOX_LIMIT;
  const shown = showAll ? inbox.rows : inbox.rows.slice(0, limit);
  const hidden = pmInboxHidden(inbox.rows.slice(limit));
  const focusAt = Math.min(focus, shown.length - 1);
  const content =
    inbox.rows.length + inbox.snoozed.length + inbox.recent.length > 0 || undo !== null;
  // Ghostex's `work_dock_hidden`: folded only while every row now was there when it was folded.
  const folded =
    content &&
    undo === null &&
    hiddenRows !== null &&
    inbox.rows.every((row) => hiddenRows.has(row.key));
  const onFold = () =>
    setPmDockHidden(key, folded ? null : new Set(inbox.rows.map((row) => row.key)));

  const onUndo = (next: InboxUndo | null) => {
    if (next === null) return;
    const id = Date.now();
    setUndo({ ...next, id });
    setTimeout(() => setUndo((current) => (current?.id === id ? null : current)), UNDO_MS);
  };
  const context: RowContext = {
    target,
    canOperate,
    now,
    phone,
    cwd: undefined,
    menu,
    onMenu: setMenu,
  };

  // Ghostex's Inbox keys: Up and Down move round the rows, Enter opens, E archives or dismisses,
  // S snoozes, Esc goes back to the chat box.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const row: PmInboxRow | undefined = shown[focusAt];
    const count = shown.length;
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          if (count > 0) setFocus((focusAt + 1) % count);
          return true;
        case "ArrowUp":
          if (count > 0) setFocus((Math.max(focusAt, 0) + count - 1) % count);
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

  const archiveAll = canOperate ? inbox.archiveAll : null;
  const moreParts = [
    hidden.pings > 0
      ? gt("{count, plural, one {# more ping} other {# more pings}}", { count: hidden.pings })
      : null,
    hidden.blocked > 0 ? gt("{count} more blocked", { count: hidden.blocked }) : null,
    hidden.done > 0 ? gt("{count} more done", { count: hidden.done }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <section
      data-pm-inbox={key}
      data-pm-inbox-rows={inbox.rows.length > 0 ? inbox.rows.length : undefined}
      aria-label={gt("Inbox")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && focus < 0 && shown.length > 0) setFocus(0);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(-1);
      }}
      className="pm-inbox-glass mb-2 overflow-hidden rounded-xl border border-border pm-inbox-title text-foreground outline-none"
    >
      <InboxHeader
        target={target}
        inbox={inbox}
        collapsible={content}
        folded={folded}
        onFold={onFold}
      />
      {!content || folded ? null : (
        <div className="max-h-[min(360px,40vh)] overflow-y-auto p-1">
          {shown.length > 0 ? (
            <div role="list">
              {shown.map((row, index) => (
                <InboxRowView
                  key={row.key}
                  row={row}
                  context={context}
                  focused={index === focusAt}
                />
              ))}
            </div>
          ) : null}
          {/* Ghostex's foot: "N more" (or Show fewer) shares a line with Archive all; with nothing
              hidden, Archive all sits alone under a hairline. */}
          {inbox.rows.length > limit || archiveAll ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-2 px-2",
                inbox.rows.length > limit
                  ? "pt-1 pb-1.25"
                  : "mt-0.5 border-foreground/6 border-t pt-1.25 pb-1",
              )}
            >
              {inbox.rows.length > limit ? (
                <button
                  type="button"
                  aria-expanded={showAll}
                  onClick={() => setShowAll(!showAll)}
                  className="truncate ps-5.75 text-start text-muted-foreground hover:text-foreground"
                >
                  {showAll ? gt("Show fewer") : moreParts.join(" · ")}
                </button>
              ) : null}
              {inbox.rows.length > limit ? <span className="min-w-2 flex-1" /> : null}
              {archiveAll ? (
                <ArchiveAll
                  archiveAll={archiveAll}
                  alone={inbox.rows.length <= limit}
                  onArchive={() => void archive(target, archiveAll).then(onUndo)}
                />
              ) : null}
            </div>
          ) : null}
          {undo ? (
            <div className="mt-[3px] flex min-w-0 items-center gap-2 rounded-lg border border-foreground/8 bg-foreground/4 px-2 py-1.25">
              <InboxIcon name="archive" className="size-[13px] shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {gt("Archived {count}", { count: undo.count })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setUndo(null);
                  void undo.undo();
                }}
                className="shrink-0 rounded-md border border-foreground/12 bg-foreground/6 px-2 py-0.5 font-medium text-foreground hover:bg-foreground/12"
              >
                {gt("Undo")}
              </button>
              <button
                type="button"
                aria-label={gt("Dismiss")}
                onClick={() => setUndo(null)}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              >
                <InboxIcon name="x" className="size-3" />
              </button>
            </div>
          ) : null}
          {inbox.snoozed.length > 0 ? (
            <Drawer
              foldKey={`dock-snoozed:${key}`}
              icon="moon"
              iconClassName="pm-card-muted"
              label={gt("Snoozed")}
              count={inbox.snoozed.length}
            >
              {inbox.snoozed.map((row) => (
                <InboxRowView key={row.key} row={row} context={context} drawer />
              ))}
            </Drawer>
          ) : null}
          {inbox.recent.length > 0 ? (
            <Drawer
              foldKey={`dock-recent:${key}`}
              icon="circleCheck"
              iconClassName={GREEN}
              label={gt("Recent", {
                $context: "Inbox drawer of finished work and answered questions",
              })}
              count={inbox.recent.length}
              action={
                canOperate ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                      <QuietButton
                        label={gt("Archive all, {count}", { count: inbox.recent.length })}
                        onClick={() => void archiveRecent(target, inbox.recent).then(onUndo)}
                        size="drawer"
                      >
                        {gt("Archive all")}
                      </QuietButton>
                    </TooltipTrigger>
                    <TooltipPopup side="top">{gt("Archive all recent items")}</TooltipPopup>
                  </Tooltip>
                ) : null
              }
            >
              {inbox.recent.map((row) =>
                row.kind === "finished" ? (
                  <InboxRowView key={row.key} row={row} context={context} drawer />
                ) : (
                  <HandledRow key={row.key} row={row} now={now} />
                ),
              )}
            </Drawer>
          ) : null}
        </div>
      )}
    </section>
  );
}

function InboxHeader(props: {
  readonly target: InboxTarget;
  readonly inbox: PmInbox;
  readonly collapsible: boolean;
  readonly folded: boolean;
  readonly onFold: () => void;
}) {
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "pm.focusInbox");
  const { counts } = props.inbox;
  const open = props.collapsible && !props.folded;
  const quiet = counts.pings + counts.blocked + counts.inProgress === 0;
  // Ghostex's quiet bar: "Nothing in progress" only when there is nothing to fold either.
  const nothing = quiet && !props.collapsible;
  return (
    <div
      data-pm-inbox-head=""
      onClick={props.collapsible ? props.onFold : undefined}
      className={cn(
        "flex h-[34px] min-w-0 cursor-default items-center gap-1.5 overflow-hidden ps-3 pe-1.25 pm-inbox-text pm-card-muted",
        props.collapsible && "pm-inbox-head",
        open && "h-[35px] rounded-t-xl border-border border-b bg-foreground/[3.5%]",
      )}
    >
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.25 font-semibold text-foreground",
                  (!quiet || nothing) && "me-1.5",
                )}
              />
            }
          >
            <InboxIcon name="inbox" className="size-3.5 text-foreground/85" />
            {gt("Inbox")}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {gt("Session Inbox")}
            {shortcut ? <span className="ms-2 text-muted-foreground">{shortcut}</span> : null}
          </TooltipPopup>
        </Tooltip>
        {counts.pings > 0 ? (
          <CountChip
            icon="circleDot"
            className={PINK}
            count={counts.pings}
            word={gt("{count, plural, one {ping} other {pings}}", {
              count: counts.pings,
              $context: "Inbox count word after its number",
            })}
            tooltip={gt("Open Pings in Work")}
            onClick={() => openWorkGroup(props.target, "needs_you")}
          />
        ) : null}
        {counts.blocked > 0 ? (
          <CountChip
            icon="circleMinusFilled"
            className={RED}
            count={counts.blocked}
            word={gt("blocked", { $context: "Inbox count word after its number" })}
            tooltip={gt("Open Blocked in Work")}
            onClick={() => openWorkGroup(props.target, "blocked")}
          />
        ) : null}
        {counts.inProgress > 0 ? (
          <CountChip
            icon="circleHalf"
            className={AMBER}
            count={counts.inProgress}
            word={gt("in progress", { $context: "Inbox count word after its number" })}
            tooltip={gt("Open In progress in Work")}
            onClick={() => openWorkGroup(props.target, "in_progress")}
          />
        ) : null}
        {nothing ? (
          <span className="truncate text-muted-foreground">{gt("Nothing in progress")}</span>
        ) : null}
      </div>
      <span className="min-w-2 flex-1" />
      {props.collapsible ? (
        <button
          type="button"
          aria-expanded={!props.folded}
          aria-label={props.folded ? gt("Show the Inbox") : gt("Fold the Inbox")}
          onClick={(event) => {
            event.stopPropagation();
            props.onFold();
          }}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <InboxIcon
            name="chevronDown"
            className={cn("size-3.5 transition-transform", props.folded && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}

function CountChip(props: {
  readonly icon: InboxGlyph;
  readonly className: string;
  readonly count: number;
  readonly word: string;
  readonly tooltip: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-pm-chip=""
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
            className="group/chip pm-inbox-chip inline-flex shrink-0 items-center gap-1.25 whitespace-nowrap rounded-md px-1.5 py-0.5"
          />
        }
      >
        <InboxIcon name={props.icon} className={cn("size-[13px]", props.className)} />
        <span className="inline-flex items-center gap-1">
          <span className="text-foreground tabular-nums">{props.count}</span>
          <span className="pm-card-muted group-hover/chip:text-foreground max-sm:hidden">
            {props.word}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Archive all under the rows: what it sweeps in words, then the button with its count. */
function ArchiveAll(props: {
  readonly archiveAll: NonNullable<PmInbox["archiveAll"]>;
  readonly alone: boolean;
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
    <>
      <span
        className={cn(
          "min-w-0 truncate pm-inbox-note text-muted-foreground",
          props.alone && "flex-1",
        )}
      >
        {summary}
      </span>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <QuietButton
            label={gt("Archive all, {count}", { count: pages + todos })}
            onClick={props.onArchive}
            size="footer"
          >
            {gt("Archive all")}
            <CountBadge count={pages + todos} />
          </QuietButton>
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Archive all pages and plain to-dos")}</TooltipPopup>
      </Tooltip>
    </>
  );
}

/** Snoozed or Recent under the rows: Ghostex's drawer line, folded until clicked. */
function Drawer(props: {
  readonly foldKey: string;
  readonly icon: InboxGlyph;
  readonly iconClassName: string;
  readonly label: string;
  readonly count: number;
  /** Shown on the line while the drawer is open. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = usePmFold(props.foldKey, false);
  return (
    <>
      {/* The whole line toggles, as Ghostex's does; its button is there for the keyboard. */}
      <div
        onClick={() => setOpen(!open)}
        className="flex min-w-0 cursor-default items-center gap-2.5 rounded-lg px-2 py-1.25 text-muted-foreground hover:bg-foreground/4 hover:text-foreground"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${props.label}, ${props.count}`}
          className="flex min-w-0 flex-1 cursor-default items-center gap-2.5 text-start"
        >
          <InboxIcon
            name={props.icon}
            className={cn("size-[13px] shrink-0", props.iconClassName)}
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate">{props.label}</span>
            <CountBadge count={props.count} />
          </span>
        </button>
        {open ? props.action : null}
        <InboxIcon
          name="chevronDown"
          className={cn("size-3 shrink-0 pm-card-muted", open && "rotate-180")}
        />
      </div>
      {open ? props.children : null}
    </>
  );
}

/** An answered ask or page in Recent: Ghostex's quiet line; a click shows the turn that settled it. */
function HandledRow(props: { readonly row: PmInboxHandled; readonly now: number }) {
  const gt = useGT();
  const age = useAgeLabel();
  const { row } = props;
  return (
    <button
      type="button"
      onClick={() => {
        if (row.messageId === null || !showMessageInChat(row.messageId))
          toastManager.add({
            type: "info",
            title: gt("That turn isn't loaded in this chat any more."),
          });
      }}
      className="flex w-full min-w-0 cursor-default items-center gap-2.5 rounded-lg px-2 py-1.25 text-start opacity-72 hover:bg-foreground/4"
    >
      <InboxIcon name="messageCheck" className="size-[13px] shrink-0 pm-handled-mark" />
      <span className="min-w-0 flex-1 truncate pm-card-muted">{row.title}</span>
      {row.outcome ? (
        <span className="max-w-[180px] shrink-0 truncate bg-foreground/5 px-1.5 py-px pm-inbox-outcome">
          {row.outcome}
        </span>
      ) : null}
      <span className="shrink-0 text-muted-foreground tabular-nums">{age(row.at, props.now)}</span>
    </button>
  );
}
