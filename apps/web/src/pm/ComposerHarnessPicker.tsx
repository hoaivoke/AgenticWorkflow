import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { BotIcon, CheckIcon, LayersIcon, Settings2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { ComposerControl } from "../components/chat/ComposerControl";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { runPmCommand } from "./actions";
import { pmCommands, usePipelinesSnapshot, useThreadHarness } from "./state";

/**
 * Compact composer pill for picking a unified role/harness on any thread (Claude, Codex,
 * Antigravity/Gemini) and inspecting the live skills & context files carried across model switches.
 */
export function ComposerHarnessPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly size?: "xs" | "sm";
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const enabled = props.projectId !== null && props.threadId !== null;
  const harnessQuery = useThreadHarness(props.environmentId, props.threadId, enabled);
  const snapshotQuery = usePipelinesSnapshot(props.environmentId, props.projectId, enabled && open);

  if (!enabled || props.threadId === null) return null;

  const harness = harnessQuery.data ?? null;
  const activeRoleName = harness?.roleName ?? null;
  const trackedSkills = harness?.trackedSkills ?? [];
  const trackedContextFiles = harness?.trackedContextFiles ?? [];
  const trackedCount = trackedSkills.length + trackedContextFiles.length;
  const roles = snapshotQuery.data?.roles ?? [];

  const updateHarness = async (patch: {
    readonly roleName: string | null;
    readonly trackedSkills?: ReadonlyArray<string>;
    readonly trackedContextFiles?: ReadonlyArray<string>;
  }) => {
    if (saving || props.threadId === null) return;
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.threadHarnessSet,
      {
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          roleName: patch.roleName,
          ...(patch.trackedSkills !== undefined ? { trackedSkills: patch.trackedSkills } : {}),
          ...(patch.trackedContextFiles !== undefined
            ? { trackedContextFiles: patch.trackedContextFiles }
            : {}),
        },
      },
      gt("Could not update thread harness"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) {
      harnessQuery.refresh();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  type="button"
                  size={props.size ?? "sm"}
                  disabled={props.disabled}
                  aria-label={
                    activeRoleName
                      ? gt("Thread harness: {role}", { role: activeRoleName })
                      : gt("Select unified thread harness")
                  }
                  className={cn("shrink-0 gap-1", activeRoleName !== null && "text-foreground")}
                >
                  <LayersIcon className="size-3.5 shrink-0" aria-hidden />
                  <span data-composer-control-label className="max-w-28 truncate">
                    {activeRoleName ?? gt("Harness")}
                  </span>
                  {trackedCount > 0 ? (
                    <Badge variant="secondary" size="sm">
                      {trackedCount}
                    </Badge>
                  ) : null}
                </ComposerControl>
              }
            />
          }
        />
        <TooltipPopup>
          {activeRoleName ? (
            <T>
              Active harness: <Var>{activeRoleName}</Var> (shared across models)
            </T>
          ) : (
            <T>Pick a role harness & view carried-over skills</T>
          )}
        </TooltipPopup>
      </Tooltip>

      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
            <div>
              <p className="text-xs font-semibold text-foreground">
                <T>Unified Thread Harness</T>
              </p>
              <p className="text-2xs text-muted-foreground">
                <T>Shared across Claude, Codex, and Antigravity on this thread.</T>
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/pipelines" });
              }}
            >
              <Settings2Icon className="size-3" aria-hidden />
              <T>Studio</T>
            </Button>
          </div>

          <div className="space-y-1">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              <T>Role preset</T>
            </p>
            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              <button
                type="button"
                disabled={saving}
                onClick={() => void updateHarness({ roleName: null })}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  activeRoleName === null && "bg-accent/70 font-medium",
                )}
              >
                <span>
                  <T>None (default prompt)</T>
                </span>
                {activeRoleName === null ? <CheckIcon className="size-3.5" aria-hidden /> : null}
              </button>

              {roles.map((entry) => {
                const selected = activeRoleName === entry.role.name;
                return (
                  <button
                    key={entry.role.name}
                    type="button"
                    disabled={saving}
                    onClick={() => void updateHarness({ roleName: entry.role.name })}
                    className={cn(
                      "flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected && "bg-accent/70",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-foreground">
                          {entry.role.name}
                        </span>
                        <Badge variant="outline" size="sm">
                          {entry.role.tier}
                        </Badge>
                      </div>
                      <p className="line-clamp-1 text-2xs text-muted-foreground">
                        {entry.role.description}
                      </p>
                    </div>
                    {selected ? (
                      <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              <BotIcon className="size-3" aria-hidden />
              <T>Tracked Skills & Context Carryover</T>
            </div>

            {trackedSkills.length === 0 && trackedContextFiles.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                <T>
                  Skills (SKILL.md) and key docs read during this thread are automatically tracked
                  and handed off when you switch models.
                </T>
              </p>
            ) : (
              <div className="space-y-1.5">
                {trackedSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {trackedSkills.map((skill) => (
                      <button
                        key={skill}
                        type="button"
                        disabled={saving}
                        aria-label={gt("Remove tracked skill {skill}", { skill })}
                        onClick={() =>
                          void updateHarness({
                            roleName: activeRoleName,
                            trackedSkills: trackedSkills.filter((item) => item !== skill),
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-2xs text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span>{skill}</span>
                        <XIcon className="size-2.5" aria-hidden />
                      </button>
                    ))}
                  </div>
                ) : null}

                {trackedContextFiles.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {trackedContextFiles.map((filePath) => (
                      <button
                        key={filePath}
                        type="button"
                        disabled={saving}
                        aria-label={gt("Remove tracked context file {file}", { file: filePath })}
                        onClick={() =>
                          void updateHarness({
                            roleName: activeRoleName,
                            trackedContextFiles: trackedContextFiles.filter(
                              (item) => item !== filePath,
                            ),
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-3xs text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="max-w-44 truncate">{filePath}</span>
                        <XIcon className="size-2.5" aria-hidden />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
