import type { EnvironmentId, PmSwarmMemberState, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowUpRightIcon, SendIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatShortTimestamp } from "../timestampFormat";
import { runPmCommand } from "./actions";
import { pmCommands, useSwarmBoard } from "./state";

type ThreadRef = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const MEMBER_STATE_TONE: Record<PmSwarmMemberState, string> = {
  working: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  waiting: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  stopped: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  killed: "bg-muted text-muted-foreground line-through",
};

/** Live Swarm Board shown for coordinator or worker threads belonging to an active/recent swarm. */
export function SwarmBoardSection(props: { readonly threadRef: ThreadRef }) {
  const gt = useGT();
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const query = useSwarmBoard(props.threadRef.environmentId, props.threadRef.threadId);
  const board = query.data;
  const [selectedChannel, setSelectedChannel] = useState<string>("all");
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const swarmStatus = board?.swarm.status ?? null;
  const refresh = query.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the active swarm board on a 3s interval while mounted and clears the timer on unmount
  useEffect(() => {
    if (swarmStatus !== "active") return;
    const timer = window.setInterval(() => {
      refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [swarmStatus, refresh]);

  const channels = (board?.channels ?? []).filter((channel) => !channel.archived);
  const mainChannel = channels.find((channel) => channel.name === "main");
  const boundPipelineMatch = mainChannel?.topic.match(/^pipeline:([a-z0-9_-]+)/i);
  const boundPipelineName = boundPipelineMatch?.[1] ?? null;
  const allPosts = board?.posts ?? [];
  const flaggedScreenshots = allPosts.flatMap((post) => {
    const found: Array<{
      readonly seq: number;
      readonly sender: string;
      readonly path: string;
      readonly caption: string;
    }> = [];
    for (const line of post.text.split("\n")) {
      const match = /^\s*Screenshot:\s*([^|]+?)\s*\|\s*(.+)$/i.exec(line);
      if (match?.[1] && match[2]) {
        found.push({
          seq: post.seq,
          sender: post.sender,
          path: match[1].trim(),
          caption: match[2].trim(),
        });
      }
    }
    return found;
  });
  const posts = (
    selectedChannel === "all"
      ? allPosts
      : allPosts.filter((post) => post.channel === selectedChannel)
  ).slice(-60);

  if (!board) return null;

  const workingCount = board.members.filter((member) => member.state === "working").length;
  const waitingCount = board.members.filter((member) => member.state === "waiting").length;

  const activeComposeChannel =
    selectedChannel !== "all" && channels.some((c) => c.name === selectedChannel)
      ? selectedChannel
      : "main";

  const sendPost = async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    const ok = await runPmCommand(
      pmCommands.swarmPost,
      {
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          text,
          channel: activeComposeChannel,
        },
      },
      gt("Could not post to the swarm board"),
    ).catch(() => false);
    setPosting(false);
    if (ok) {
      setDraft("");
      refresh();
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-swarm-board"
      title={board.swarm.title || gt("Swarm board")}
      separated={false}
      actions={
        <div className="flex items-center gap-1.5">
          {boundPipelineName ? (
            <Badge variant="secondary" size="sm">
              {boundPipelineName}
            </Badge>
          ) : null}
          <UsersIcon className="size-3.5 text-muted-foreground" aria-hidden />
          <Badge variant={board.swarm.status === "active" ? "info" : "outline"} size="sm">
            {board.swarm.status === "active" ? gt("Active") : gt("Done")}
          </Badge>
        </div>
      }
    >
      <div className="flex flex-col gap-2.5 px-2.5 pb-1 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
          <span>
            {gt("{working} working · {waiting} waiting · {total} total", {
              working: workingCount,
              waiting: waitingCount,
              total: board.members.length,
            })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {board.members.map((member) => (
            <Tooltip key={member.name}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(
                            props.threadRef.environmentId,
                            member.threadId as ThreadId,
                          ),
                        ),
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-2xs transition-colors hover:bg-accent"
                  />
                }
              >
                <span className="font-medium">@{member.name}</span>
                <span
                  className={cn(
                    "rounded px-1 py-px text-3xs font-medium",
                    MEMBER_STATE_TONE[member.state],
                  )}
                >
                  {member.state}
                </span>
                {member.workspaceMode === "worktree" ? (
                  <span className="rounded bg-muted px-1 py-px text-3xs text-muted-foreground">
                    wt
                  </span>
                ) : null}
                <ArrowUpRightIcon className="size-2.5 text-muted-foreground" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>
                {member.role
                  ? `@${member.name} (${member.role}, ${member.workspaceMode})`
                  : `@${member.name} (${member.workspaceMode})`}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>

        {channels.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1">
            {(["all", ...channels.map((channel) => channel.name)] as const).map((channelName) => (
              <button
                key={channelName}
                type="button"
                onClick={() => setSelectedChannel(channelName)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-2xs transition-colors",
                  selectedChannel === channelName
                    ? "bg-foreground text-background"
                    : "bg-muted/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {channelName === "all" ? gt("All") : `#${channelName}`}
              </button>
            ))}
          </div>
        ) : null}

        {flaggedScreenshots.length > 0 ? (
          <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/50 p-2">
            <div className="text-3xs font-medium text-muted-foreground">
              {gt("Screenshots ({count})", { count: flaggedScreenshots.length })}
            </div>
            <div className="flex flex-col gap-1">
              {flaggedScreenshots.slice(-6).map((shot) => (
                <div
                  key={`${shot.seq}:${shot.path}`}
                  className="flex items-center justify-between gap-2 text-2xs"
                >
                  <span className="min-w-0 truncate text-foreground/90">{shot.caption}</span>
                  <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                    @{shot.sender} #{shot.seq}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-md border border-border/60 bg-background/50 p-2">
          {posts.length === 0 ? (
            <div className="text-muted-foreground">{gt("No board messages yet.")}</div>
          ) : (
            posts.map((post) => (
              <div
                key={post.seq}
                className="flex flex-col gap-0.5 border-b border-border/40 pb-1.5 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2 text-3xs text-muted-foreground">
                  <span className="font-mono">
                    #{post.seq} #{post.channel} @{post.sender}
                  </span>
                  <span>{formatShortTimestamp(post.createdAt, timestampFormat)}</span>
                </div>
                <div className="whitespace-pre-wrap break-words text-2xs text-foreground/90">
                  {post.text}
                </div>
              </div>
            ))
          )}
        </div>

        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void sendPost();
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={gt("Post to #{channel} (@name to wake)...", {
              channel: activeComposeChannel,
            })}
            aria-label={gt("Post to swarm board")}
            disabled={posting}
          />
          <Button
            type="submit"
            size="icon-xs"
            variant="secondary"
            disabled={posting || draft.trim().length === 0}
            aria-label={gt("Send swarm post")}
          >
            <SendIcon className="size-3" />
          </Button>
        </form>
      </div>
    </ThreadDetailsSection>
  );
}
