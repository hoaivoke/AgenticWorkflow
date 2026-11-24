import type { PmPageSummary } from "@t3tools/contracts";
import {
  PM_ANSWERED_IN_CHAT,
  PM_SNOOZE_HOURS,
  pmAskTag,
  pmInboxAge,
  pmInboxAsksQuestion,
  pmInboxMarkdown,
  type PmInboxMark,
  type PmInboxRow,
} from "@t3tools/pm/client";
import { useGT } from "gt-react";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  answerAsk,
  archive,
  archiveDone,
  type InboxTarget,
  mentionInComposer,
  openInboxPage,
  openWorkGroup,
  replyToPage,
  showMessageInChat,
  snoozeRow,
} from "./inboxActions";
import { InboxIcon, type InboxGlyph } from "./inboxIcons";

// t3code-pm: one Inbox row, Ghostex's dock row (gx-chat-core extras/work_cards.rs `dock_row`).

export const PINK = "pm-ping";
export const RED = "pm-blocked";
export const AMBER = "pm-progress";
export const GREEN = "pm-done";

const MARKS: Record<PmInboxMark, readonly [InboxGlyph, string]> = {
  blocked: ["circleMinusFilled", RED],
  todo: ["checkbox", PINK],
  question: ["helpCircle", PINK],
  page: ["file", PINK],
  pages: ["stack", PINK],
  finished: ["circleCheck", GREEN],
};

/** The 13px mark (12px on a bundle's page) in a box one title line tall, on the title's middle. */
function RowMark(props: { readonly mark: PmInboxMark; readonly small?: boolean }) {
  const [glyph, color] = MARKS[props.mark];
  return (
    <span aria-hidden className="pm-inbox-line flex w-[13px] shrink-0 items-center">
      <InboxIcon name={glyph} className={cn(props.small ? "size-3" : "size-[13px]", color)} />
    </span>
  );
}

export function useAgeLabel() {
  const gt = useGT();
  return (at: string, now: number) => {
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
  };
}

/** A square 28px icon button with a tooltip, Ghostex's `tone_square_icon_button`. */
function IconButton(props: {
  readonly icon: InboxGlyph;
  readonly label: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick?.();
            }}
            data-pm-button=""
            className={cn(ICON_BUTTON, props.className)}
          />
        }
      >
        <InboxIcon name={props.icon} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/7 text-foreground/80 hover:bg-foreground/12 hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** The Reply box's actions are words, as in Ghostex's reply popover. */
const PLAIN_BUTTON =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 font-medium pm-inbox-text text-foreground hover:bg-foreground/8 disabled:pointer-events-none disabled:opacity-50";

const TEXT_BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-foreground/7 px-2.5 text-sm text-foreground hover:bg-foreground/12 disabled:pointer-events-none disabled:opacity-50";

function TextButton(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      data-pm-button=""
      className={TEXT_BUTTON}
    >
      {props.children}
    </button>
  );
}

const QUIET_SIZE = {
  /** A bundle row's Expand and Archive all. */
  row: "px-2 py-0.5 pm-inbox-note leading-[22.75px]",
  /** Recent's Archive all, on the drawer's line. */
  drawer: "px-2 py-px pm-inbox-note leading-[18.75px]",
  /** The Inbox's own Archive all, padded for its count. */
  footer: "py-[3px] ps-[9px] pe-1.5 pm-inbox-footer",
} as const;

/** Ghostex's quiet bordered button: the Archive alls and a bundle's Expand. */
export function QuietButton(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly label?: string;
  readonly size?: keyof typeof QUIET_SIZE;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className={cn(
        "inline-flex shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap rounded-md border border-foreground/10 bg-foreground/4 text-foreground hover:bg-foreground/9",
        QUIET_SIZE[props.size ?? "row"],
      )}
    >
      {props.children}
    </button>
  );
}

/** Ghostex's `count_badge`: an 18px circle for one digit, a pill for more. */
export function CountBadge(props: { readonly count: number }) {
  return (
    <span className="inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-foreground/10 px-1.25 font-medium text-2xs text-foreground/80 leading-none tabular-nums">
      {props.count}
    </span>
  );
}

/** The row's ⋯ or right-click menu, or its Snooze sheet; one open in the Inbox at a time. */
export interface RowMenuRequest {
  readonly key: string;
  readonly mode: "full" | "snooze";
  readonly at: { readonly x: number; readonly y: number } | null;
}

export interface RowContext {
  readonly target: InboxTarget;
  readonly canOperate: boolean;
  readonly now: number;
  readonly phone: boolean;
  readonly cwd: string | undefined;
  readonly menu: RowMenuRequest | null;
  readonly onMenu: (request: RowMenuRequest | null) => void;
}

/** The row's Archive or Dismiss, for its button, its menu, the E key and a left swipe. Silent:
 * only the bulk Archive all gets Ghostex's Undo bar. */
export function rowArchive(context: RowContext, row: PmInboxRow): (() => void) | null {
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

const rowMention = (row: PmInboxRow) =>
  row.kind === "ask"
    ? pmAskTag(row.ask)
    : row.kind === "page"
      ? `"${row.page.title}"`
      : row.kind === "blocked" || row.kind === "finished"
        ? `W${row.item.itemNo}`
        : null;

const rowTitle = (row: PmInboxRow) =>
  row.kind === "ask"
    ? row.ask.title
    : row.kind === "page"
      ? row.page.title
      : row.kind === "blocked" || row.kind === "finished"
        ? row.item.title
        : "";

function useSnoozeLabel() {
  const gt = useGT();
  return (hours: number) =>
    gt("{count, plural, one {# hour} other {# hours}}", { count: hours, $context: "Snooze for" });
}

function RowMenu(props: {
  readonly row: PmInboxRow;
  readonly context: RowContext;
  readonly anchor: HTMLElement | null;
}) {
  const gt = useGT();
  const snoozeLabel = useSnoozeLabel();
  const { row, context } = props;
  const request = context.menu?.key === row.key ? context.menu : null;
  const asks = pmInboxAsksQuestion(row);
  const archiveRow = rowArchive(context, row);
  const snoozable = row.kind === "ask" || row.kind === "page";
  const mention = rowMention(row);
  const markdown = pmInboxMarkdown(row);
  const chatMessage = row.kind === "page" ? row.page.messageId : null;
  const at = request?.at;
  const snoozeItems = PM_SNOOZE_HOURS.map((hours) => (
    <MenuItem
      key={hours}
      disabled={!context.canOperate}
      onClick={() => void snoozeRow(context.target, row, hours)}
    >
      <InboxIcon name="moon" className="size-4" />
      {snoozeLabel(hours)}
    </MenuItem>
  ));
  return (
    <Menu open={request !== null} onOpenChange={(open) => !open && context.onMenu(null)}>
      <MenuPopup
        anchor={at ? { getBoundingClientRect: () => new DOMRect(at.x, at.y, 0, 0) } : props.anchor}
        align={at ? "start" : "end"}
        side="bottom"
        sideOffset={at ? 0 : 4}
      >
        {request?.mode === "snooze" ? (
          <MenuGroup>
            <MenuGroupLabel>{gt('Snooze "{title}"', { title: rowTitle(row) })}</MenuGroupLabel>
            {snoozeItems}
          </MenuGroup>
        ) : (
          <>
            {row.snoozedUntil !== null ? (
              <MenuItem
                disabled={!context.canOperate}
                onClick={() => void snoozeRow(context.target, row, null)}
              >
                <InboxIcon name="alarmOff" className="size-4" />
                {gt("Unsnooze")}
              </MenuItem>
            ) : null}
            {chatMessage ? (
              <MenuItem
                onClick={() => {
                  if (!showMessageInChat(chatMessage))
                    toastManager.add({ type: "info", title: gt("That message is not loaded") });
                }}
              >
                <InboxIcon name="messageShare" className="size-4" />
                {gt("Show in chat")}
              </MenuItem>
            ) : null}
            {asks ? (
              <MenuItem
                disabled={!context.canOperate}
                onClick={() =>
                  void (row.kind === "ask"
                    ? answerAsk(context.target, row.ask.askNo, PM_ANSWERED_IN_CHAT)
                    : row.kind === "page"
                      ? replyToPage(context.target, row.page.pageId, PM_ANSWERED_IN_CHAT)
                      : null)
                }
              >
                <InboxIcon name="circleCheck" className="size-4" />
                {gt("Mark answered")}
              </MenuItem>
            ) : null}
            {archiveRow ? (
              <MenuItem disabled={!context.canOperate} onClick={archiveRow}>
                <InboxIcon name={asks ? "x" : "check"} className="size-4" />
                {asks ? gt("Dismiss") : gt("Archive")}
                <MenuShortcut>E</MenuShortcut>
              </MenuItem>
            ) : null}
            {snoozable && row.snoozedUntil === null ? (
              <MenuSub>
                <MenuSubTrigger disabled={!context.canOperate}>
                  <InboxIcon name="moon" className="size-4" />
                  {gt("Snooze")}
                  <MenuShortcut>S</MenuShortcut>
                </MenuSubTrigger>
                <MenuSubPopup>{snoozeItems}</MenuSubPopup>
              </MenuSub>
            ) : null}
            {markdown || mention ? <MenuSeparator /> : null}
            {markdown ? (
              <MenuItem onClick={() => void navigator.clipboard?.writeText(markdown)}>
                <InboxIcon name="markdown" className="size-4" />
                {gt("Copy as Markdown")}
              </MenuItem>
            ) : null}
            {mention ? (
              <MenuItem onClick={() => mentionInComposer(context.target, mention)}>
                <InboxIcon name="quote" className="size-4" />
                {gt("Mention in chat box")}
              </MenuItem>
            ) : null}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** Reply: the reader's own words, to the chat box or straight to the PM. */
function ReplyButton(props: {
  readonly row: PmInboxRow;
  readonly context: RowContext;
  readonly onSent?: () => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { row, context } = props;
  const question = pmInboxAsksQuestion(row) || row.kind === "ask";
  const title = rowTitle(row);
  const mention = rowMention(row);
  const words = text.trim();
  const send =
    row.kind === "ask"
      ? (reply: string) => answerAsk(context.target, row.ask.askNo, reply)
      : row.kind === "page"
        ? (reply: string) => replyToPage(context.target, row.page.pageId, reply)
        : null;
  const toChatBox = () => {
    if (words === "" && mention === null) return;
    mentionInComposer(context.target, [mention ? `${mention}:` : "", words].join(" ").trim());
    setText("");
    setOpen(false);
  };
  const sendNow = async () => {
    if (words === "") return;
    if (send === null) return toChatBox();
    if ((await send(words)) === null) return;
    setText("");
    setOpen(false);
    props.onSent?.();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={gt("Reply")}
            disabled={!context.canOperate}
            onClick={(event) => event.stopPropagation()}
            data-pm-button=""
            className={ICON_BUTTON}
          />
        }
      >
        <InboxIcon name="reply" className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="compact" width="lg">
        <div className="flex flex-col gap-2" onClick={(event) => event.stopPropagation()}>
          <textarea
            autoFocus
            rows={3}
            value={text}
            placeholder={
              title
                ? gt("Reply about {title}…", { title })
                : question
                  ? gt("Your answer…")
                  : gt("Reply…")
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              if (event.altKey) toChatBox();
              else void sendNow();
            }}
            className="w-full resize-none bg-transparent px-1 pm-inbox-text outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" onClick={toChatBox} className={PLAIN_BUTTON}>
              {question ? gt("Reply in chat box") : gt("Add to prompt")}
              <span className="text-muted-foreground">⌥⏎</span>
            </button>
            {send ? (
              <button
                type="button"
                disabled={words === ""}
                onClick={() => void sendNow()}
                className={PLAIN_BUTTON}
              >
                {question ? gt("Send answer") : gt("Send reply")}
              </button>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Answers on the row, the recommended one starred; folded into Choices when they would crowd it. */
function Answers(props: {
  readonly answers: ReadonlyArray<string>;
  readonly recommended: string | null;
  readonly context: RowContext;
  /** Room, in the same rough units, that a Details button beside the answers takes. */
  readonly beside?: number;
  readonly onAnswer: (answer: string) => void;
}) {
  const gt = useGT();
  const width = props.answers.reduce((sum, answer) => sum + answer.length + 4, props.beside ?? 0);
  const fits =
    props.answers.length <= (props.context.phone ? 2 : 3) &&
    width <= (props.context.phone ? 16 : 34);
  const star = (answer: string) =>
    answer === props.recommended ? (
      <InboxIcon name="star" filled className="size-2.5 pm-star" />
    ) : null;
  if (fits)
    return props.answers.map((answer) => (
      <TextButton
        key={answer}
        disabled={!props.context.canOperate}
        onClick={() => props.onAnswer(answer)}
      >
        {star(answer)}
        {answer}
      </TextButton>
    ));
  return (
    <Menu>
      <MenuTriggerButton label={gt("Choices")} disabled={!props.context.canOperate} />
      <MenuPopup side="bottom" align="end">
        {props.answers.map((answer) => (
          <MenuItem key={answer} onClick={() => props.onAnswer(answer)}>
            {star(answer)}
            {answer}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function MenuTriggerButton(props: { readonly label: string; readonly disabled: boolean }) {
  return (
    <MenuTrigger
      disabled={props.disabled}
      render={
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          data-pm-button=""
          className={TEXT_BUTTON}
        />
      }
    >
      {props.label}
      <InboxIcon name="chevronDown" className="size-3.5 text-muted-foreground" />
    </MenuTrigger>
  );
}

/** The whole ask, opened from its row: Ghostex's dock ask panel. */
function AskDialog(props: {
  readonly row: PmInboxRow & { readonly kind: "ask" };
  readonly context: RowContext;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const age = useAgeLabel();
  const { row, context } = props;
  const answer = (value: string) => {
    props.onOpenChange(false);
    void answerAsk(context.target, row.ask.askNo, value);
  };
  const answers = row.todo ? [gt("Done", { $context: "answer to a to-do" })] : row.ask.answers;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-[680px]">
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-2.5 pe-8">
            <RowMark mark={row.mark} />
            <DialogTitle className="min-w-0 flex-1">{row.ask.title}</DialogTitle>
            <span className="pm-inbox-line flex shrink-0 items-center text-muted-foreground text-xs">
              {age(row.at, context.now)}
            </span>
          </div>
          {row.ask.detail.trim() ? (
            <div className="max-h-[60vh] overflow-y-auto text-sm">
              <ChatMarkdown text={row.ask.detail} cwd={context.cwd} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {answers.map((choice) => (
              <TextButton
                key={choice}
                disabled={!context.canOperate}
                onClick={() => answer(choice)}
              >
                {choice === row.ask.recommended ? (
                  <InboxIcon name="star" filled className="size-2.5 pm-star" />
                ) : null}
                {choice}
              </TextButton>
            ))}
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <ReplyButton row={row} context={context} onSent={() => props.onOpenChange(false)} />
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

const SWIPE_AT = 68;
const SWIPE_MAX = 104;

/** A phone's swipe: left archives or dismisses, right opens Snooze. */
function useSwipe(onLeft: (() => void) | null, onRight: (() => void) | null) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);
  const handlers = {
    onPointerDown: (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    },
    onPointerMove: (event: PointerEvent) => {
      const from = start.current;
      if (from === null || from.id !== event.pointerId) return;
      const move = event.clientX - from.x;
      if (Math.abs(event.clientY - from.y) > Math.abs(move) && dx === 0) {
        start.current = null;
        return;
      }
      const allowed = (move < 0 && onLeft) || (move > 0 && onRight);
      setDx(allowed ? Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, move)) : 0);
    },
    onPointerUp: () => {
      start.current = null;
      if (dx <= -SWIPE_AT) onLeft?.();
      else if (dx >= SWIPE_AT) onRight?.();
      setDx(0);
    },
    onPointerCancel: () => {
      start.current = null;
      setDx(0);
    },
  };
  return { dx, handlers };
}

export function InboxRowView(props: {
  readonly row: PmInboxRow;
  readonly context: RowContext;
  readonly focused?: boolean;
  /** Drawn in the Done or Snoozed drawer: the same row, quieter. */
  readonly drawer?: boolean;
  /** A page under its expanded bundle: mark, title and age only. */
  readonly nested?: boolean;
}) {
  const gt = useGT();
  const age = useAgeLabel();
  const { row, context } = props;
  const [more, setMore] = useState<HTMLButtonElement | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const asks = pmInboxAsksQuestion(row);
  const archiveRow = context.canOperate ? rowArchive(context, row) : null;
  const snoozable = context.canOperate && (row.kind === "ask" || row.kind === "page");
  const swipe = useSwipe(
    context.phone && !props.nested ? archiveRow : null,
    context.phone && snoozable && !props.nested
      ? () => context.onMenu({ key: row.key, mode: "snooze", at: null })
      : null,
  );
  const menuOpen = context.menu?.key === row.key;
  const finished = row.kind === "finished";

  const openRow = () => {
    if (row.kind === "ask") setAskOpen(true);
    else if (row.kind === "page") void openInboxPage(context.target, row.page);
    else if (row.kind === "pages") setExpanded(!expanded);
    else openWorkGroup(context.target, row.kind === "blocked" ? "blocked" : "done");
  };

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

  const buttons: Array<ReactNode> = [];
  if (props.nested || finished) {
    // A finished row's Archive is its hover check; a bundle's page has no buttons.
  } else if (row.kind === "pages") {
    buttons.push(
      <QuietButton key="expand" onClick={() => setExpanded(!expanded)}>
        {expanded ? gt("Collapse") : gt("Expand")}
      </QuietButton>,
    );
    if (archiveRow)
      buttons.push(
        <Tooltip key="all">
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <QuietButton onClick={archiveRow}>{gt("Archive all")}</QuietButton>
          </TooltipTrigger>
          <TooltipPopup side="top">{gt("Archive all pages")}</TooltipPopup>
        </Tooltip>,
      );
  } else {
    if (!asks && archiveRow)
      buttons.push(
        <IconButton key="archive" icon="check" label={gt("Archive")} onClick={archiveRow} />,
      );
    if (row.kind === "ask") {
      // Ghostex keeps the answers on the row and puts a quiet Details beside them.
      buttons.push(
        <Answers
          key="answers"
          answers={row.todo ? [gt("Done", { $context: "answer to a to-do" })] : row.ask.answers}
          recommended={row.ask.recommended}
          context={context}
          beside={row.details ? 11 : 0}
          onAnswer={(answer) => void answerAsk(context.target, row.ask.askNo, answer)}
        />,
      );
      if (row.details)
        buttons.push(
          <Tooltip key="details">
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setAskOpen(true);
                  }}
                  className="inline-flex h-7 shrink-0 cursor-default items-center rounded-lg border border-foreground/12 bg-foreground/5 px-2.75 pm-card-muted hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15"
                />
              }
            >
              {gt("Details")}
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Details")}</TooltipPopup>
          </Tooltip>,
        );
    }
    if (row.kind === "page")
      buttons.push(
        <IconButton
          key="open"
          icon="externalLink"
          label={gt("Open page")}
          onClick={() => void openInboxPage(context.target, row.page)}
        />,
      );
    buttons.push(<ReplyButton key="reply" row={row} context={context} />);
  }

  const strip =
    swipe.dx < 0
      ? {
          className: "pm-swipe-archive justify-end",
          icon: asks ? ("x" as const) : ("check" as const),
          label: asks ? gt("Dismiss") : gt("Archive"),
        }
      : swipe.dx > 0
        ? { className: "pm-swipe-snooze justify-start", icon: "moon" as const, label: gt("Snooze") }
        : null;

  const ageLabel =
    row.snoozedUntil !== null
      ? gt("back in {age}", {
          age: age(new Date(context.now).toISOString(), Date.parse(row.snoozedUntil)),
          $context: "When a snoozed Inbox row comes back",
        })
      : age(row.at, context.now);
  const slotShown = menuOpen || props.focused;

  return (
    <div className={cn("relative", props.nested && "ms-5.5 border-border border-s-2 ps-1")}>
      {strip ? (
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center gap-1.5 rounded-lg px-4 font-medium pm-inbox-text",
            strip.className,
          )}
        >
          <InboxIcon name={strip.icon} className="size-4" />
          {strip.label}
        </div>
      ) : null}
      <div
        role="listitem"
        data-pm-inbox-row={row.key}
        data-focused={props.focused ? "" : undefined}
        onClick={openRow}
        onContextMenu={(event) => {
          if (props.nested) return;
          event.preventDefault();
          context.onMenu({
            key: row.key,
            mode: "full",
            at: { x: event.clientX, y: event.clientY },
          });
        }}
        {...swipe.handlers}
        style={swipe.dx === 0 ? undefined : { transform: `translateX(${swipe.dx}px)` }}
        className={cn(
          "pm-inbox-row group/row relative cursor-default touch-pan-y rounded-lg px-2 py-1.5",
          // Opaque only while it slides over its swipe strip.
          swipe.dx !== 0 && "bg-card",
          props.drawer && "opacity-72",
        )}
      >
        <div className="flex items-start gap-2.5">
          <RowMark mark={row.mark} small={props.nested === true} />
          <span
            className={cn(
              "pm-inbox-title min-w-0 flex-1 truncate",
              row.unread ? "text-foreground" : "pm-card-muted",
            )}
          >
            {title}
          </span>
          {buttons.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">{buttons}</div>
          ) : null}
          <div className="pm-inbox-line relative flex min-w-[26px] shrink-0 items-center justify-end">
            <span
              className={cn(
                "whitespace-nowrap pm-inbox-title text-muted-foreground tabular-nums",
                !props.nested && "group-hover/row:invisible",
                !props.nested && slotShown && "invisible",
              )}
            >
              {ageLabel}
            </span>
            {props.nested ? null : finished ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Archive")}
                      disabled={archiveRow === null}
                      onClick={(event) => {
                        event.stopPropagation();
                        archiveRow?.();
                      }}
                      className={cn(SLOT_BUTTON, slotShown && "opacity-100")}
                    />
                  }
                >
                  <InboxIcon name="check" className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">{gt("Archive")}</TooltipPopup>
              </Tooltip>
            ) : (
              <button
                ref={setMore}
                type="button"
                aria-label={gt("More actions")}
                onClick={(event) => {
                  event.stopPropagation();
                  context.onMenu(menuOpen ? null : { key: row.key, mode: "full", at: null });
                }}
                className={cn(SLOT_BUTTON, slotShown && "opacity-100")}
              >
                <InboxIcon name="dots" className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        {preview ? (
          <div className="truncate ps-5.75 pm-inbox-preview pm-card-muted">{preview}</div>
        ) : null}
      </div>
      {props.nested ? null : <RowMenu row={row} context={context} anchor={more} />}
      {row.kind === "ask" ? (
        <AskDialog row={row} context={context} open={askOpen} onOpenChange={setAskOpen} />
      ) : null}
      {row.kind === "pages" && expanded ? (
        <div className="py-0.5">
          {row.pages.map((page: PmPageSummary) => (
            <InboxRowView
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
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The age slot's hover button, laid over the age so nothing shifts: 26x22, a hair past the edge. */
const SLOT_BUTTON =
  "absolute inset-y-0 -end-0.5 m-auto inline-flex h-5.5 w-6.5 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 disabled:pointer-events-none";
