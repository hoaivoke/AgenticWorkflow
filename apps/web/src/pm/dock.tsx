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
import { setPmDockHidden, usePmDockHidden, usePmFold } from "./uiState";

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
  // The tick is UTC `YYYY-MM-DDTHH:mm`; without the zone Date.parse would read it as local time.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  if (detail === null) return null;
  return <InboxSurface target={props.target} inbox={pmInbox(detail, now)} now={now} />;
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
    inbox.rows.length +
      inbox.done.length +
      inbox.snoozed.length +
      inbox.answered.length +
      (undo ? 1 : 0) >
    0;
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
      className="pm-inbox-glass mb-2 overflow-hidden rounded-xl border border-border text-foreground text-sm outline-none"
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
          {moreParts.length > 0 && !showAll ? (
            <MoreLine onClick={() => setShowAll(true)}>{moreParts.join(" · ")}</MoreLine>
          ) : null}
          {showAll && inbox.rows.length > limit ? (
            <MoreLine onClick={() => setShowAll(false)}>{gt("Show fewer")}</MoreLine>
          ) : null}
          {inbox.archiveAll && canOperate ? (
            <ArchiveAllFooter
              archiveAll={inbox.archiveAll}
              onArchive={() => void archive(target, inbox.archiveAll ?? {}).then(onUndo)}
            />
          ) : null}
          {undo ? (
            <div className="mt-0.5 flex h-9 items-center gap-2 border-foreground/6 border-t ps-2 pe-0.5 text-sm">
              <InboxIcon name="archive" className="size-[13px] text-muted-foreground" />
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
                className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              >
                <InboxIcon name="x" className="size-3.5" />
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
              foldKey={`dock-handled:${key}`}
              icon="messageCheck"
              iconClassName={GREEN}
              label={gt("Handled", { $context: "Inbox drawer of questions already answered" })}
              count={inbox.answered.length}
            >
              {inbox.answered.map((row) => (
                <HandledRow key={row.key} row={row} now={now} />
              ))}
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
  return (
    <div
      data-pm-inbox-head=""
      onClick={props.collapsible ? props.onFold : undefined}
      className={cn(
        "flex h-[34px] min-w-0 cursor-default items-center gap-1.5 overflow-hidden ps-3 pe-1.25 pm-inbox-text",
        props.collapsible && "pm-inbox-head",
        open && "h-[35px] rounded-t-xl border-border border-b bg-foreground/[3.5%]",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="me-1.5 inline-flex shrink-0 items-center gap-1.25 font-semibold" />
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
      {quiet ? (
        <span className="truncate text-muted-foreground">{gt("Nothing in progress")}</span>
      ) : null}
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
      <span className="flex-1" />
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
        <span className="text-foreground tabular-nums">{props.count}</span>
        <span className="text-muted-foreground group-hover/chip:text-foreground max-sm:hidden">
          {props.word}
        </span>
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
      className="block w-full truncate rounded-lg py-1 ps-7.75 pe-2 text-start text-muted-foreground text-sm hover:bg-foreground/4 hover:text-foreground"
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
    <div className="mt-0.5 flex items-center gap-2 border-foreground/6 border-t px-2 pt-1.25 pb-1">
      <span className="flex-1 truncate pm-inbox-note text-muted-foreground">{summary}</span>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <TextButton onClick={props.onArchive}>
            {gt("Archive all")}
            <CountBadge count={pages + todos} />
          </TextButton>
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Archive all pages and plain to-dos")}</TooltipPopup>
      </Tooltip>
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
    <div className="mt-0.5 border-foreground/6 border-t">
      <div className="flex h-8 items-center gap-2 ps-2 pe-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
        >
          <InboxIcon name={props.icon} className={cn("size-[13px]", props.iconClassName)} />
          <span>{props.label}</span>
          <CountBadge count={props.count} />
          <InboxIcon
            name="chevronDown"
            className={cn("size-3 transition-transform", !open && "-rotate-90")}
          />
        </button>
        {open ? props.action : null}
      </div>
      {open ? <div className="pb-0.5">{props.children}</div> : null}
    </div>
  );
}

/** A Handled row: Ghostex's compact settled line; a click shows the turn that settled it. */
function HandledRow(props: { readonly row: PmInboxAnswered; readonly now: number }) {
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
      className="flex w-full items-center gap-2 rounded-lg py-1.25 ps-6 pe-2 text-start opacity-72 hover:bg-foreground/4"
    >
      <InboxIcon name="messageCheck" className="size-3 shrink-0 pm-handled-mark" />
      <span className="pm-inbox-title min-w-0 flex-1 truncate text-muted-foreground">
        {row.title}
      </span>
      {row.outcome ? (
        <span className="max-w-[180px] shrink-0 truncate pm-inbox-note pm-inbox-outcome rounded-full px-2">
          {row.outcome}
        </span>
      ) : null}
      <span className="min-w-[26px] shrink-0 text-end text-muted-foreground text-xs tabular-nums">
        {age(row.at, props.now)}
      </span>
    </button>
  );
}
